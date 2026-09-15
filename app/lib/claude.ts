/**
 * Full-content document transcription via Claude Fable.
 *
 * One upload == one document == one request. Every rendered page is sent as an
 * image in a single message, and the model returns the document's entire
 * content as generic structured JSON (pages -> blocks). There is no
 * document-specific schema: a German purchase order, a contract and a delivery
 * note all come back in the same shape, with every label and value copied
 * verbatim in the document's own language.
 *
 * The API key is read by the SDK from `ANTHROPIC_API_KEY` and never leaves the
 * server: it is not returned, not logged, not put on any error.
 */

import Anthropic from "@anthropic-ai/sdk";

/**
 * Claude Fable 5.1 — the most capable widely released model. Thinking is always
 * on for this model, and it rejects sampling parameters (`temperature` etc.).
 */
export const CLAUDE_MODEL = "claude-fable-5-1";

/**
 * Output token ceiling (thinking + JSON). A dense page transcribes to roughly
 * 1.5–3k tokens of JSON, so this covers a long document. Streaming is used, so a
 * large ceiling does not risk an HTTP timeout. A document that still hits it
 * fails with kind `truncated` instead of returning partial content.
 */
export const MAX_OUTPUT_TOKENS = 64000;

/**
 * On a safety-classifier decline, the API re-runs the request on Anthropic's
 * recommended fallback model inside the same call. `response.model` then names
 * the model that actually answered.
 */
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

/** USD per million tokens, for the cost estimate shown in the UI. */
const PRICING: Record<string, { input: number; output: number }> = {
  "claude-fable-5-1": { input: 10, output: 50 },
  "claude-fable-5": { input: 10, output: 50 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
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
  | "rate-limit"
  | "request-too-large"
  | "api-error"
  | "network"
  | "timeout"
  | "refusal" // every model in the fallback chain declined
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
  /** Estimated USD cost from the public price list; null for an unknown model. */
  cost_usd: number | null;
};

export type ClaudeResult = {
  document: DocumentExtraction;
  /** Model that produced the answer — differs from CLAUDE_MODEL after a fallback. */
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

function estimateCost(model: string, input: number, output: number): number | null {
  const price = PRICING[model];
  if (!price) return null;
  return (input * price.input + output * price.output) / 1_000_000;
}

let client: Anthropic | null = null;

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
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new ClaudeError(
      "missing-api-key",
      "ANTHROPIC_API_KEY is not set on the server.",
    );
  }
  if (pages.length === 0) {
    throw new ClaudeError("empty-response", "No page images to send to Claude.");
  }
  client ??= new Anthropic();

  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  for (const p of pages) {
    content.push({ type: "text", text: `Page ${p.pageNumber}:` });
    content.push({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: p.base64 },
    });
  }
  content.push({
    type: "text",
    text: `Transcribe the complete content of this ${pages.length}-page document.`,
  });

  const startedAt = performance.now();
  let message: Anthropic.Beta.BetaMessage;
  try {
    const stream = client.beta.messages.stream(
      {
        model: CLAUDE_MODEL,
        max_tokens: MAX_OUTPUT_TOKENS,
        betas: [FALLBACK_BETA],
        fallbacks: "default",
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content }],
        output_config: {
          format: { type: "json_schema", schema: DOCUMENT_JSON_SCHEMA },
        },
      },
      { signal: opts.signal },
    );
    if (opts.onProgress) {
      let chars = 0;
      stream.on("text", (delta) => {
        chars += delta.length;
        opts.onProgress?.(chars);
      });
    }
    message = await stream.finalMessage();
  } catch (err) {
    throw toClaudeError(err);
  }
  const claudeMs = Math.round(performance.now() - startedAt);

  // Check stop_reason before reading content: a refusal can leave content
  // empty or partial.
  if (message.stop_reason === "refusal") {
    const category = message.stop_details?.category;
    throw new ClaudeError(
      "refusal",
      `The model declined to process this document${category ? ` (category: ${category})` : ""}.`,
    );
  }
  if (message.stop_reason === "max_tokens") {
    throw new ClaudeError(
      "truncated",
      `The document's content exceeded the ${MAX_OUTPUT_TOKENS}-token output limit, ` +
        `so the transcription would be incomplete. Split the document and retry.`,
    );
  }

  // After a mid-stream fallback the text is split around a `fallback` block and
  // the fallback model continues the partial, so all text blocks join into one.
  const rawContent = message.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("");
  if (!rawContent.trim()) {
    throw new ClaudeError(
      "empty-response",
      `Model returned no text content (stop_reason=${message.stop_reason ?? "unknown"}).`,
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

  const input = message.usage.input_tokens;
  const output = message.usage.output_tokens;
  return {
    document: parsed as DocumentExtraction,
    model: message.model,
    usage: {
      input_tokens: input,
      output_tokens: output,
      cost_usd: estimateCost(message.model, input, output),
    },
    stopReason: message.stop_reason,
    rawContent,
    claudeMs,
  };
}

function toClaudeError(err: unknown): ClaudeError {
  if (err instanceof Anthropic.APIUserAbortError) {
    return new ClaudeError("timeout", "The Claude request was cancelled.", { cause: err });
  }
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return new ClaudeError("timeout", "The Claude request timed out.", { cause: err });
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new ClaudeError("network", `Network error calling Claude: ${msg(err)}`, {
      cause: err,
    });
  }
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new ClaudeError("auth", `Anthropic authentication failed: ${msg(err)}`, {
      cause: err,
      status: err.status,
    });
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new ClaudeError(
      "rate-limit",
      "Anthropic rate limit reached. Wait a moment and try again.",
      { cause: err, status: err.status },
    );
  }
  if (err instanceof Anthropic.APIError && err.status === 413) {
    return new ClaudeError(
      "request-too-large",
      "The rendered pages exceed the API's 32 MB request limit. Upload fewer pages.",
      { cause: err, status: err.status },
    );
  }
  if (err instanceof Anthropic.APIError) {
    return new ClaudeError("api-error", `Anthropic API error (HTTP ${err.status}): ${msg(err)}`, {
      cause: err,
      status: err.status,
    });
  }
  return new ClaudeError("api-error", `Unexpected Claude error: ${msg(err)}`, { cause: err });
}
