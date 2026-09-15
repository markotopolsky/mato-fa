import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

/**
 * These tests exercise the OpenRouter *request shape* and *response handling*
 * in `claude.ts` by stubbing `globalThis.fetch` with a canned SSE stream. No
 * network, no real API key required.
 */

type Handler = (url: string, init: RequestInit) => Response;
let handler: Handler;
let lastBody: Record<string, unknown> | null = null;
let lastUrl = "";

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  lastUrl = String(input);
  lastBody = init?.body ? JSON.parse(String(init.body)) : null;
  return handler(String(input), init ?? {});
}) as typeof fetch;

const { extractDocument, ClaudeError, CLAUDE_MODEL } = await import("../app/lib/claude.ts");

const PAGES = [{ pageNumber: 1, base64: "AAAA" }];

const DOCUMENT = {
  language: "de",
  document_type: "Bestellung",
  pages: [
    {
      page: 1,
      blocks: [
        { type: "heading", text: "Bestellung", key: null, value: null, items: null, rows: null },
        { type: "key_value", text: null, key: "Bestellnummer", value: "4500123", items: null, rows: null },
        {
          type: "table",
          text: null,
          key: null,
          value: null,
          items: null,
          rows: [["Menge", "Artikel", "Preis"], ["10", "Schrauben", "1.234,56 €"]],
        },
      ],
    },
  ],
};

function sse(
  chunks: string[],
  opts: {
    finishReason?: string;
    nativeFinishReason?: string;
    model?: string;
    cost?: number;
  } = {},
): Response {
  const model = opts.model ?? CLAUDE_MODEL;
  const events: unknown[] = [
    ...chunks.map((content) => ({
      model,
      choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
    })),
    {
      model,
      choices: [
        {
          index: 0,
          delta: { content: "" },
          finish_reason: opts.finishReason ?? "stop",
          native_finish_reason: opts.nativeFinishReason ?? "end_turn",
        },
      ],
    },
    {
      model,
      choices: [],
      usage: {
        prompt_tokens: 2000,
        completion_tokens: 1000,
        total_tokens: 3000,
        ...(opts.cost === undefined ? {} : { cost: opts.cost }),
      },
    },
  ];
  // Split the body mid-line to exercise buffering across network chunks.
  const body =
    ": OPENROUTER PROCESSING\n\n" +
    events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") +
    "data: [DONE]\n\n";
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < body.length; i += 37) {
        controller.enqueue(encoder.encode(body.slice(i, i + 37)));
      }
      controller.close();
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream" } });
}

let savedKey: string | undefined;
beforeEach(() => {
  savedKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "test-key";
  lastBody = null;
});
afterEach(() => {
  if (savedKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = savedKey;
});

test("sends every page and the schema to OpenRouter", async () => {
  handler = () => sse([JSON.stringify(DOCUMENT)]);
  await extractDocument([
    { pageNumber: 1, base64: "AAAA" },
    { pageNumber: 2, base64: "BBBB" },
  ]);

  assert.equal(lastUrl, "https://openrouter.ai/api/v1/chat/completions");
  assert.ok(lastBody);
  assert.equal(lastBody.model, "anthropic/claude-fable-5.1");
  assert.equal(lastBody.stream, true);
  assert.ok(!("temperature" in lastBody), "Fable rejects sampling parameters");
  const format = lastBody.response_format as { type: string; json_schema: { strict: boolean } };
  assert.equal(format.type, "json_schema");
  assert.equal(format.json_schema.strict, true);

  const messages = lastBody.messages as { role: string; content: unknown }[];
  const user = messages.find((m) => m.role === "user")!;
  const images = (user.content as { type: string; image_url?: { url: string } }[]).filter(
    (b) => b.type === "image_url",
  );
  assert.equal(images.length, 2);
  assert.equal(images[0].image_url?.url, "data:image/jpeg;base64,AAAA");
});

test("returns the parsed document, joined across stream chunks", async () => {
  const json = JSON.stringify(DOCUMENT);
  handler = () => sse([json.slice(0, 50), json.slice(50)]);
  const progress: number[] = [];
  const result = await extractDocument(PAGES, { onProgress: (c) => progress.push(c) });

  assert.deepEqual(result.document, DOCUMENT);
  assert.equal(result.rawContent, json);
  assert.equal(result.usage.input_tokens, 2000);
  assert.equal(result.usage.output_tokens, 1000);
  assert.equal(result.usage.cost_usd, (2000 * 10 + 1000 * 50) / 1_000_000);
  assert.equal(progress.at(-1), json.length);
});

test("prefers the cost OpenRouter reports", async () => {
  handler = () => sse([JSON.stringify(DOCUMENT)], { model: "anthropic/claude-opus-5", cost: 0.042 });
  const result = await extractDocument(PAGES);
  assert.equal(result.model, "anthropic/claude-opus-5");
  assert.equal(result.usage.cost_usd, 0.042);
});

test("a refusal is an error, never a partial document", async () => {
  handler = () =>
    sse(['{"language":"de","pa'], { finishReason: "stop", nativeFinishReason: "refusal" });
  await assert.rejects(
    () => extractDocument(PAGES),
    (e: unknown) => e instanceof ClaudeError && e.kind === "refusal",
  );
});

test("hitting max_tokens is kind=truncated", async () => {
  handler = () =>
    sse(['{"language":"de","pages":[{"page":1,'], {
      finishReason: "length",
      nativeFinishReason: "max_tokens",
    });
  await assert.rejects(
    () => extractDocument(PAGES),
    (e: unknown) => e instanceof ClaudeError && e.kind === "truncated",
  );
});

test("JSON without a pages array is kind=wrong-structure", async () => {
  handler = () => sse(['{"language":"de"}']);
  await assert.rejects(
    () => extractDocument(PAGES),
    (e: unknown) => e instanceof ClaudeError && e.kind === "wrong-structure",
  );
});

test("HTTP 401 is kind=auth", async () => {
  handler = () =>
    new Response(JSON.stringify({ error: { code: 401, message: "No auth credentials found" } }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  await assert.rejects(
    () => extractDocument(PAGES),
    (e: unknown) => e instanceof ClaudeError && e.kind === "auth",
  );
});

test("HTTP 402 is kind=insufficient-credit", async () => {
  handler = () =>
    new Response(JSON.stringify({ error: { code: 402, message: "requires more credits" } }), {
      status: 402,
      headers: { "content-type": "application/json" },
    });
  await assert.rejects(
    () => extractDocument(PAGES),
    (e: unknown) => e instanceof ClaudeError && e.kind === "insufficient-credit",
  );
});

test("an error chunk mid-stream is an error", async () => {
  handler = () =>
    new Response(`data: ${JSON.stringify({ error: { code: 502, message: "Provider returned error" } })}\n\n`, {
      headers: { "content-type": "text/event-stream" },
    });
  await assert.rejects(
    () => extractDocument(PAGES),
    (e: unknown) => e instanceof ClaudeError && e.kind === "api-error",
  );
});

test("a missing API key fails before any request", async () => {
  delete process.env.OPENROUTER_API_KEY;
  handler = () => {
    throw new Error("fetch must not be called");
  };
  await assert.rejects(
    () => extractDocument(PAGES),
    (e: unknown) => e instanceof ClaudeError && e.kind === "missing-api-key",
  );
});
