import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { extractInvoice, QwenError } from "../app/lib/qwen.ts";

/**
 * These tests exercise the OpenRouter/Qwen *request shape* and *response
 * handling* in `qwen.ts` by stubbing `globalThis.fetch`. No network, no API key
 * required.
 *
 * Background: the Alibaba provider on OpenRouter accepts `response_format:
 * json_schema` but does not grammar-enforce it, so `message.content` can arrive
 * as a bare JSON string, fenced, or double-encoded (those are recovered). A
 * top-level JSON array means the model returned multiple/wrapped invoices and
 * is a hard error — never merged, never unwrapped.
 */

const PAGES = [{ pageNumber: 1, dataUrl: "data:image/png;base64,AAAA" }];

const INVOICE = {
  invoice_number: "INV-1",
  invoice_date: null,
  due_date: null,
  supplier_name: "Acme",
  supplier_address: null,
  supplier_ico: "31421202",
  supplier_dic: "2020362058",
  supplier_ic_dph: "SK2020362058",
  customer_name: null,
  customer_address: null,
  customer_ico: null,
  customer_dic: null,
  customer_ic_dph: null,
  currency: "EUR",
  subtotal: 100,
  tax_total: 21,
  total: 121,
  payment_reference: null,
  iban: "SK89 1100 0000 0026 1234 5678",
  items: [
    {
      description: "A",
      quantity: 2,
      unit: "ks",
      unit_price: 25,
      unit_price_includes_vat: false,
      tax_rate: 21,
      line_net: 50,
      line_vat: 10.5,
      line_gross: 60.5,
    },
    {
      description: "B",
      quantity: 1,
      unit: null,
      unit_price: 50,
      unit_price_includes_vat: false,
      tax_rate: 21,
      line_net: 50,
      line_vat: 10.5,
      line_gross: 60.5,
    },
  ],
};

const realFetch = globalThis.fetch;

/** Captures the outgoing request of the most recent mocked call. */
let lastRequestBody: Record<string, unknown> | null = null;

function mockOnce(status: number, body: unknown, contentType = "application/json") {
  lastRequestBody = null;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    lastRequestBody = JSON.parse(init.body as string) as Record<string, unknown>;
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return new Response(text, { status, headers: { "content-type": contentType } });
  }) as unknown as typeof fetch;
}

/** A well-formed OpenAI-shape chat completion whose message.content is `content`. */
function completion(content: unknown, extra: Record<string, unknown> = {}) {
  return {
    model: "qwen/qwen3.8-max",
    choices: [
      {
        finish_reason: "stop",
        message: { role: "assistant", content, ...extra },
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.001 },
  };
}

beforeEach(() => {
  process.env.OPENROUTER_API_KEY = "sk-test-fake";
});
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.OPENROUTER_API_KEY;
});

/* ---------------------------------------------------------- request shape -- */

test("request sets max_tokens = 8000", async () => {
  mockOnce(200, completion(JSON.stringify(INVOICE)));
  await extractInvoice(PAGES);
  assert.equal(lastRequestBody?.max_tokens, 8000);
});

test("system prompt carries the single-invoice / no-array instruction", async () => {
  mockOnce(200, completion(JSON.stringify(INVOICE)));
  await extractInvoice(PAGES);
  const messages = lastRequestBody?.messages as { role: string; content: string }[];
  const system = messages.find((m) => m.role === "system")?.content ?? "";
  assert.ok(
    system.includes(
      "Return exactly ONE invoice object for the whole document. A multi-page invoice is still one invoice — never split pages into separate invoices, and never return a JSON array.",
    ),
    "system prompt is missing the exact single-invoice instruction",
  );
});

/* ------------------------------------------------------------ happy paths -- */

test("plain JSON-object string content -> parsed invoice + usage", async () => {
  mockOnce(200, completion(JSON.stringify(INVOICE)));
  const r = await extractInvoice(PAGES);
  assert.equal(r.invoice.invoice_number, "INV-1");
  assert.equal(r.invoice.items.length, 2);
  assert.equal(r.usage.total_tokens, 15);
  assert.equal(r.usage.cost, 0.001);
  assert.equal(r.finishReason, "stop");
});

test("markdown-fenced JSON content is unwrapped", async () => {
  mockOnce(200, completion("```json\n" + JSON.stringify(INVOICE) + "\n```"));
  const r = await extractInvoice(PAGES);
  assert.equal(r.invoice.items.length, 2);
});

test("double-encoded JSON string content is re-parsed", async () => {
  mockOnce(200, completion(JSON.stringify(JSON.stringify(INVOICE))));
  const r = await extractInvoice(PAGES);
  assert.equal(r.invoice.invoice_number, "INV-1");
});

// The Alibaba provider honours the schema's `properties` but not its root
// `type: "object"`, so a schema-conforming invoice arrives wrapped as
// `[{...}]`. One element leaves nothing to choose between, so it is unwrapped
// as a shape correction; two or more stay a hard error (see below).
test("single-element top-level array is unwrapped", async () => {
  mockOnce(200, completion(JSON.stringify([INVOICE])));
  const r = await extractInvoice(PAGES);
  assert.equal(r.invoice.invoice_number, "INV-1");
  assert.equal(r.invoice.items.length, 2);
});

test("large items array is not truncated", async () => {
  const many = {
    ...INVOICE,
    items: Array.from({ length: 120 }, (_, i) => ({
      description: `row ${i + 1}`,
      quantity: 1,
      unit: "ks",
      unit_price: 1,
      unit_price_includes_vat: false,
      tax_rate: 21,
      line_net: 1,
      line_vat: 0.21,
      line_gross: 1.21,
    })),
  };
  mockOnce(200, completion(JSON.stringify(many)));
  const r = await extractInvoice(PAGES);
  assert.equal(r.invoice.items.length, 120);
});

/* ----------------------------------------------------- distinct failures -- */

async function kindOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return "<no error>";
  } catch (e) {
    return e instanceof QwenError ? e.kind : `<${(e as Error).name}>`;
  }
}

test("multi-element top-level array -> wrong-structure, names the count, not merged", async () => {
  mockOnce(200, completion(JSON.stringify([INVOICE, INVOICE, INVOICE])));
  await assert.rejects(
    () => extractInvoice(PAGES),
    (e: unknown) =>
      e instanceof QwenError &&
      e.kind === "wrong-structure" &&
      /array of 3 invoice/i.test(e.message) &&
      /not merged or unwrapped/i.test(e.message),
  );
});

test("top-level null -> wrong-structure", async () => {
  mockOnce(200, completion("null"));
  assert.equal(await kindOf(() => extractInvoice(PAGES)), "wrong-structure");
});

test("object without items[] -> wrong-structure", async () => {
  mockOnce(200, completion(JSON.stringify({ invoice_number: "X" })));
  assert.equal(await kindOf(() => extractInvoice(PAGES)), "wrong-structure");
});

test("non-JSON prose content -> invalid-json", async () => {
  mockOnce(200, completion("Sorry, here is the invoice: ..."));
  assert.equal(await kindOf(() => extractInvoice(PAGES)), "invalid-json");
});

test("empty content -> empty-response", async () => {
  mockOnce(200, completion(""));
  assert.equal(await kindOf(() => extractInvoice(PAGES)), "empty-response");
});

test("refusal field -> refusal", async () => {
  mockOnce(200, completion(null, { refusal: "I can't help with that." }));
  assert.equal(await kindOf(() => extractInvoice(PAGES)), "refusal");
});

test("HTTP 401 -> auth", async () => {
  mockOnce(401, { error: { code: 401, message: "no key" } });
  assert.equal(await kindOf(() => extractInvoice(PAGES)), "auth");
});

test("HTTP 500 -> api-error", async () => {
  mockOnce(500, { error: { message: "upstream boom" } });
  assert.equal(await kindOf(() => extractInvoice(PAGES)), "api-error");
});

test("HTTP 200 body with error object (code 403) -> auth", async () => {
  mockOnce(200, { error: { code: 403, message: "disabled" } });
  assert.equal(await kindOf(() => extractInvoice(PAGES)), "auth");
});

test("non-JSON HTTP body -> invalid-response", async () => {
  mockOnce(200, "<html>502</html>", "text/html");
  assert.equal(await kindOf(() => extractInvoice(PAGES)), "invalid-response");
});

test("no choices in response -> invalid-response", async () => {
  mockOnce(200, { model: "qwen/qwen3.8-max", choices: [] });
  assert.equal(await kindOf(() => extractInvoice(PAGES)), "invalid-response");
});

test("fetch throws -> network", async () => {
  globalThis.fetch = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  assert.equal(await kindOf(() => extractInvoice(PAGES)), "network");
});

test("missing OPENROUTER_API_KEY -> missing-api-key", async () => {
  delete process.env.OPENROUTER_API_KEY;
  assert.equal(await kindOf(() => extractInvoice(PAGES)), "missing-api-key");
});
