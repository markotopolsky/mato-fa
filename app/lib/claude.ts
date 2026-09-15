/**
 * Full-content document transcription via Claude Fable, routed through
 * OpenRouter.
 *
 * One upload == one document == one request. Every rendered page is sent as an
 * image in a single message, and the model returns the document's entire
 * content as generic structured JSON (pages -> blocks). There is no
 * document-specific schema: a German purchase order, a contract and a delivery
 * note all come back in the same shape, with every label and value copied
 * verbatim in the document's own language.
 *
 * The API key is read from `OPENROUTER_API_KEY` and never leaves the server: it
 * is not returned, not logged, not put on any error.
 */

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

/**
 * Claude Fable 5.1 on OpenRouter. Thinking is always on for this model, and it
 * rejects sampling parameters (`temperature` etc.).
 */
export const CLAUDE_MODEL = "anthropic/claude-fable-5.1";

/**
 * Output token ceiling (thinking + JSON). A dense page transcribes to roughly
 * 1.5–3k tokens of JSON, so this covers a long document. Streaming is used, so a
 * large ceiling does not risk an HTTP timeout. A document that still hits it
 * fails with kind `truncated` instead of returning partial content.
 *
 * OpenRouter pre-authorises credit for the whole ceiling (~$3.20 at Fable
 * output pricing); a balance below that fails with kind `insufficient-credit`.
 */
export const MAX_OUTPUT_TOKENS = 64000;

/**
 * USD per million tokens, used only when OpenRouter does not report the call's
 * actual cost.
 */
const PRICING: Record<string, { input: number; output: number }> = {
  "anthropic/claude-fable-5.1": { input: 10, output: 50 },
  "anthropic/claude-fable-5": { input: 10, output: 50 },
  "anthropic/claude-opus-5": { input: 5, output: 25 },
  "anthropic/claude-opus-4.8": { input: 5, output: 25 },
};

/* ------------------------------------------------------------------ schema -- */

/**
 * Generic content schema. Blocks are a flat, non-recursive list per page
 * (structured outputs do not support recursive schemas); fields a block type
 * does not use are null.
 */
export const DOCUMENT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    language: { type: ["string", "null"] },
    document_type: { type: ["string", "null"] },
    pages: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          page: { type: "integer" },
          blocks: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                type: {
                  type: "string",
                  enum: ["heading", "paragraph", "key_value", "list", "table", "other"],
                },
                text: { type: ["string", "null"] },
                key: { type: ["string", "null"] },
                value: { type: ["string", "null"] },
                items: {
                  anyOf: [
                    { type: "array", items: { type: "string" } },
                    { type: "null" },
                  ],
                },
                rows: {
                  anyOf: [
                    {
                      type: "array",
                      items: { type: "array", items: { type: "string" } },
                    },
                    { type: "null" },
                  ],
                },
              },
              required: ["type", "text", "key", "value", "items", "rows"],
            },
          },
        },
        required: ["page", "blocks"],
      },
    },
  },
  required: ["language", "document_type", "pages"],
} as const;

export type BlockType =
  | "heading"
  | "paragraph"
  | "key_value"
  | "list"
  | "table"
  | "other";

export type ContentBlock = {
  type: BlockType;
  /** heading / paragraph / other: the text as printed. */
  text: string | null;
  /** key_value: the printed label, e.g. "Bestellnummer". */
  key: string | null;
  /** key_value: the printed value, e.g. "4500123". */
  value: string | null;
  /** list: one string per list entry. */
  items: string[] | null;
  /** table: one array of cell strings per row, header row first if printed. */
  rows: string[][] | null;
};

export type DocumentPage = { page: number; blocks: ContentBlock[] };

export type DocumentExtraction = {
  /** ISO 639-1 code of the document's main language, e.g. "de". */
  language: string | null;
  /** What the document calls itself, verbatim, e.g. "Bestellung". */
  document_type: string | null;
  pages: DocumentPage[];
};

/* ------------------------------------------------------------------ prompt -- */

const SYSTEM_PROMPT = `You transcribe documents into structured JSON. You receive every page of one document as images, in order, and return its complete content.

The goal is a faithful, lossless digital copy that a person can store and search instead of the original. Everything a reader can see on the page belongs in the output: letterheads, addresses, reference numbers, dates, body text, every table row, totals, payment and delivery terms, footers, small print, stamps, and handwritten notes. Transcribe; do not summarise, interpret, reorder by importance, or skip content that seems unimportant.

Copy text exactly as printed, in the document's own language. Never translate. Keep every accent, umlaut and ß, and keep spelling, abbreviations, capitalisation and punctuation as they appear, errors included. Keep numbers, amounts and dates in their printed form ("1.234,56 €", "15.09.2026"), because reformatting them loses information.

Each page in the input becomes one entry in "pages", numbered from 1. Within a page, emit blocks in natural reading order:
- "heading": a title or section heading, in "text".
- "paragraph": running text, in "text". Keep a paragraph together; separate lines of an address or letterhead with "\\n".
- "key_value": a labelled field such as "Bestellnummer: 4500123" — label in "key" without the trailing colon, value in "value". Use this whenever a value is printed next to or under its label.
- "list": bulleted or numbered entries, one string per entry in "items", markers omitted.
- "table": one array of cell strings per row in "rows", the header row first when the table has one. Keep empty cells as "" so every row lines up with the header. A table that continues onto the next page is continued in that page's blocks, not merged back.
- "other": anything that fits none of the above — a stamp, signature caption, handwritten note, barcode or QR label — described briefly in "text" with any readable text copied verbatim, e.g. "[Stempel] Wareneingang 16.09.2026".
Fields a block type does not use are null.

Set "language" to the ISO 639-1 code of the main language, and "document_type" to what the document calls itself, copied verbatim (e.g. "Bestellung", "Lieferschein"), or null if it names no type.

If something is genuinely illegible, mark that spot as illegible in the document's language (e.g. "[unleserlich]" in German) rather than guessing.`;

/* ------------------------------------------------------------------- error -- */

export type ClaudeErrorKind =
  | "missing-api-key"
  | "auth"
  | "insufficient-credit" // the OpenRouter balance cannot cover MAX_OUTPUT_TOKENS
  | "rate-limit"
  | "request-too-large"
  | "api-error"
  | "network"
  | "timeout"
  | "refusal" // the model declined the document
  | "truncated" // hit MAX_OUTPUT_TOKENS; the JSON would be incomplete
  | "empty-response"
  | "invalid-json"
  | "wrong-structure";

export class ClaudeError extends Error {
  readonly kind: ClaudeErrorKind;
  readonly status?: number;

  constructor(
    kind: ClaudeErrorKind,
    message: string,
    options: { cause?: unknown; status?: number } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "ClaudeError";
    this.kind = kind;
    this.status = options.status;
  }
}

/* ------------------------------------------------------------------ result -- */

export type ClaudeUsage = {
  input_tokens: number;
  /** Includes thinking tokens, which are billed as output. */
  output_tokens: number;
  /**
   * USD cost as reported by OpenRouter, else estimated from the public price
   * list; null for an unknown model.
   */
  cost_usd: number | null;
};

export type ClaudeResult = {
  document: DocumentExtraction;
  /** Model slug echoed back by OpenRouter. */
  model: string;
  usage: ClaudeUsage;
  stopReason: string | null;
  /** Exact JSON text returned by the model, kept verbatim for debugging. */
  rawContent: string;
  claudeMs: number;
};

export type PageImage = {
  pageNumber: number;
  /** Base64 JPEG bytes, no data-URL prefix. */
  base64: string;
};

/* -------------------------------------------------------------- extraction -- */

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function estimateCost(model: string, input: number, output: number): number | null {
  const price = PRICING[model];
  if (!price) return null;
  return (input * price.input + output * price.output) / 1_000_000;
}

/** Pull a human-readable message out of an OpenRouter error body. */
function providerErrorMessage(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: unknown }; message?: unknown };
    if (typeof parsed.error?.message === "string") return parsed.error.message;
    if (typeof parsed.message === "string") return parsed.message;
  } catch {
    /* not JSON — fall through */
  }
  return raw.slice(0, 500);
}

/** Map a failed OpenRouter HTTP status to an error kind. */
function httpError(status: number, detail: string): ClaudeError {
  if (status === 401 || status === 403) {
    return new ClaudeError("auth", `OpenRouter authentication failed (HTTP ${status}): ${detail}`, {
      status,
    });
  }
  if (status === 402) {
    return new ClaudeError(
      "insufficient-credit",
      "The OpenRouter account does not have enough credit to reserve this request. " +
        "Nothing is wrong with the document — top up the account or raise the key's " +
        "spend limit and try again.",
      { status },
    );
  }
  if (status === 429) {
    return new ClaudeError("rate-limit", "OpenRouter rate limit reached. Wait a moment and try again.", {
      status,
    });
  }
  if (status === 413) {
    return new ClaudeError(
      "request-too-large",
      "The rendered pages exceed the API's request size limit. Upload fewer pages.",
      { status },
    );
  }
  return new ClaudeError("api-error", `OpenRouter API error (HTTP ${status}): ${detail}`, { status });
}

type StreamChunk = {
  model?: string;
  error?: { code?: unknown; message?: unknown };
  choices?: {
    delta?: { content?: string | null; refusal?: string | null };
    finish_reason?: string | null;
    native_finish_reason?: string | null;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
};

/**
 * Yield the payload of each server-sent `data:` line, skipping `: comment`
 * keep-alives and the final `[DONE]`.
 */
async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const data = line.startsWith("data:") ? line.slice(5).trim() : "";
      if (data && data !== "[DONE]") yield data;
    }
  }
  const data = buffer.startsWith("data:") ? buffer.slice(5).trim() : "";
  if (data && data !== "[DONE]") yield data;
}

/**
 * Send every rendered page of one document to Claude and return its full
 * content. `onProgress` receives the number of JSON characters generated so
 * far, so a caller can show the request is alive during long generations.
 * Throws {@link ClaudeError} on any failure — never a partial result.
 */
export async function extractDocument(
  pages: PageImage[],
  opts: { signal?: AbortSignal; onProgress?: (chars: number) => void } = {},
): Promise<ClaudeResult> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new ClaudeError(
      "missing-api-key",
      "OPENROUTER_API_KEY is not set on the server.",
    );
  }
  if (pages.length === 0) {
    throw new ClaudeError("empty-response", "No page images to send to Claude.");
  }

  const content: Record<string, unknown>[] = [];
  for (const p of pages) {
    content.push({ type: "text", text: `Page ${p.pageNumber}:` });
    content.push({
      type: "image_url",
      image_url: { url: `data:image/jpeg;base64,${p.base64}` },
    });
  }
  content.push({
    type: "text",
    text: `Transcribe the complete content of this ${pages.length}-page document.`,
  });

  const requestBody = {
    model: CLAUDE_MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    stream: true,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "document", strict: true, schema: DOCUMENT_JSON_SCHEMA },
    },
    // Only route to a provider that enforces the schema; fail loudly otherwise.
    provider: { require_parameters: true },
    usage: { include: true },
  };

  const startedAt = performance.now();
  let rawContent = "";
  let refusal = "";
  let finishReason: string | null = null;
  let nativeFinishReason: string | null = null;
  let model: string = CLAUDE_MODEL;
  let usage: StreamChunk["usage"] = undefined;

  try {
    const res = await fetch(OPENROUTER_URL, {
      method: "POST",
      signal: opts.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "X-Title": "Document Reader",
      },
      body: JSON.stringify(requestBody),
    });
    if (!res.ok || !res.body) {
      throw httpError(res.status, providerErrorMessage(await res.text()));
    }

    for await (const data of sseData(res.body)) {
      let chunk: StreamChunk;
      try {
        chunk = JSON.parse(data) as StreamChunk;
      } catch {
        continue;
      }
      // An error after the stream has started arrives as a chunk, not a status.
      if (chunk.error) {
        const code = typeof chunk.error.code === "number" ? chunk.error.code : 0;
        const detail = typeof chunk.error.message === "string" ? chunk.error.message : "unknown";
        throw code
          ? httpError(code, detail)
          : new ClaudeError("api-error", `OpenRouter API error: ${detail}`);
      }
      if (typeof chunk.model === "string") model = chunk.model;
      if (chunk.usage) usage = chunk.usage;
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      if (choice.native_finish_reason) nativeFinishReason = choice.native_finish_reason;
      if (choice.delta?.refusal) refusal += choice.delta.refusal;
      if (choice.delta?.content) {
        rawContent += choice.delta.content;
        opts.onProgress?.(rawContent.length);
      }
    }
  } catch (err) {
    if (err instanceof ClaudeError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new ClaudeError("timeout", "The Claude request was cancelled.", { cause: err });
    }
    throw new ClaudeError("network", `Network error calling OpenRouter: ${msg(err)}`, {
      cause: err,
    });
  }
  const claudeMs = Math.round(performance.now() - startedAt);

  // Check the finish reason before reading content: a refusal can leave content
  // empty or partial.
  if (
    refusal ||
    finishReason === "content_filter" ||
    nativeFinishReason === "refusal"
  ) {
    throw new ClaudeError(
      "refusal",
      `The model declined to process this document${refusal ? `: ${refusal}` : ""}.`,
    );
  }
  if (finishReason === "length" || nativeFinishReason === "max_tokens") {
    throw new ClaudeError(
      "truncated",
      `The document's content exceeded the ${MAX_OUTPUT_TOKENS}-token output limit, ` +
        `so the transcription would be incomplete. Split the document and retry.`,
    );
  }
  if (finishReason === "error") {
    throw new ClaudeError("api-error", "OpenRouter reported a provider error mid-generation.");
  }

  if (!rawContent.trim()) {
    throw new ClaudeError(
      "empty-response",
      `Model returned no text content (finish_reason=${finishReason ?? "unknown"}).`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    throw new ClaudeError(
      "invalid-json",
      `Model output is not valid JSON. First 200 chars: ${rawContent.slice(0, 200)}`,
    );
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    !Array.isArray((parsed as Record<string, unknown>).pages)
  ) {
    throw new ClaudeError(
      "wrong-structure",
      `Model JSON is not a document object with a "pages" array.`,
    );
  }

  const input = numberOr(usage?.prompt_tokens, 0);
  const output = numberOr(usage?.completion_tokens, 0);
  const reportedCost = usage?.cost;
  return {
    document: parsed as DocumentExtraction,
    model,
    usage: {
      input_tokens: input,
      output_tokens: output,
      cost_usd:
        typeof reportedCost === "number" && Number.isFinite(reportedCost)
          ? reportedCost
          : estimateCost(model, input, output),
    },
    stopReason: nativeFinishReason ?? finishReason,
    rawContent,
    claudeMs,
  };
}
