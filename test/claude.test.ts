import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

/**
 * These tests exercise the Claude *request shape* and *response handling* in
 * `claude.ts` by stubbing `globalThis.fetch` with a canned SSE stream. No
 * network, no real API key required.
 */

type Handler = (url: string, init: RequestInit) => Response;
let handler: Handler;
let lastBody: Record<string, unknown> | null = null;

// The SDK client is created once and keeps the fetch it saw at construction,
// so install one dispatcher up front and swap `handler` per test.
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
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
  opts: { stopReason?: string; model?: string; stopDetails?: unknown } = {},
): Response {
  const model = opts.model ?? CLAUDE_MODEL;
  const events: [string, unknown][] = [
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 2000, output_tokens: 1 },
        },
      },
    ],
    [
      "content_block_start",
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    ],
    ...chunks.map(
      (text): [string, unknown] => [
        "content_block_delta",
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
      ],
    ),
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    [
      "message_delta",
      {
        type: "message_delta",
        delta: {
          stop_reason: opts.stopReason ?? "end_turn",
          stop_sequence: null,
          stop_details: opts.stopDetails ?? null,
        },
        usage: { output_tokens: 1000 },
      },
    ],
    ["message_stop", { type: "message_stop" }],
  ];
  const body = events
    .map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
    .join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

let savedKey: string | undefined;
beforeEach(() => {
  savedKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-key";
  lastBody = null;
});
afterEach(() => {
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
});

test("sends every page, the schema and the fallback chain", async () => {
  handler = () => sse([JSON.stringify(DOCUMENT)]);
  await extractDocument([
    { pageNumber: 1, base64: "AAAA" },
    { pageNumber: 2, base64: "BBBB" },
  ]);

  assert.ok(lastBody);
  assert.equal(lastBody.model, "claude-fable-5-1");
  assert.equal(lastBody.fallbacks, "default");
  assert.equal(lastBody.stream, true);
  assert.ok(!("temperature" in lastBody), "Fable rejects sampling parameters");
  const format = (lastBody.output_config as { format: { type: string } }).format;
  assert.equal(format.type, "json_schema");

  const content = (lastBody.messages as { content: { type: string }[] }[])[0].content;
  assert.equal(content.filter((b) => b.type === "image").length, 2);
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

test("reports the model that answered after a fallback", async () => {
  handler = () => sse([JSON.stringify(DOCUMENT)], { model: "claude-opus-4-8" });
  const result = await extractDocument(PAGES);
  assert.equal(result.model, "claude-opus-4-8");
  assert.equal(result.usage.cost_usd, (2000 * 5 + 1000 * 25) / 1_000_000);
});

test("a refusal is an error, never a partial document", async () => {
  handler = () =>
    sse(['{"language":"de","pa'], {
      stopReason: "refusal",
      stopDetails: { type: "refusal", category: null, explanation: null },
    });
  await assert.rejects(
    () => extractDocument(PAGES),
    (e: unknown) => e instanceof ClaudeError && e.kind === "refusal",
  );
});

test("hitting max_tokens is kind=truncated", async () => {
  handler = () => sse(['{"language":"de","pages":[{"page":1,'], { stopReason: "max_tokens" });
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
    new Response(
      JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }),
      { status: 401, headers: { "content-type": "application/json" } },
    );
  await assert.rejects(
    () => extractDocument(PAGES),
    (e: unknown) => e instanceof ClaudeError && e.kind === "auth",
  );
});

test("a missing API key fails before any request", async () => {
  delete process.env.ANTHROPIC_API_KEY;
  handler = () => {
    throw new Error("fetch must not be called");
  };
  await assert.rejects(
    () => extractDocument(PAGES),
    (e: unknown) => e instanceof ClaudeError && e.kind === "missing-api-key",
  );
});
