/**
 * Phase 2 — invoice extraction via Qwen3.8 Max through OpenRouter.
 *
 * One PDF == one invoice == one extraction request. All rendered PNG pages are
 * sent together in a single multimodal message. No retries, no fallback, no
 * conversation state — every call is isolated so each invoice is measured on its
 * own.
 *
 * The OpenRouter API key is read from `process.env.OPENROUTER_API_KEY` and never
 * leaves this module: it is not returned, not logged, not put on any error.
 */

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

/** Model slug, exactly as required by this phase. */
export const QWEN_MODEL = "qwen/qwen3.8-max";

/**
 * Upper bound on model output tokens (reasoning + answer).
 *
 * Left unset, OpenRouter defaults this to the model maximum (65536) and
 * pre-authorises credit for the whole amount — which produced an HTTP 402 on a
 * key that could not afford it. Measured completions so far: ~1k (small
 * invoice) to ~3.4k (32 line items). 8000 covers a very large invoice plus a
 * few thousand reasoning tokens while keeping the credit reservation and the
 * worst-case cost predictable (~$0.048 output). Raise this if a genuinely huge
 * invoice hits `finish_reason: "length"`.
 */
export const MAX_OUTPUT_TOKENS = 8000;

/**
 * Hard client-side timeout for the Qwen request. `qwen3.8-max` is a reasoning
 * model: a 2-page / ~30-line invoice was measured at ~103 s, so 120 s left no
 * margin. Kept under the route's `maxDuration = 300`.
 */
const TIMEOUT_MS = 240_000;

/**
 * Connectivity-probe mode, enabled with `QWEN_RAW=1`.
 *
 * Sends the request the way the Qwen web chat does — no `response_format`, no
 * `json_schema`, no provider filter — and accepts a single-element top-level
 * array instead of rejecting it. Everything else (parsing, field coercion,
 * error kinds) is unchanged, so the pipeline still returns a real invoice.
 *
 * This is for diagnosing the connection, not a supported mode: Phase 2 requires
 * structured output, so the default (unset) path stays strict.
 */
export const RAW_MODE = process.env.QWEN_RAW === "1";

/* ------------------------------------------------------------------ schema -- */

/**
 * Structured-output JSON schema (OpenAI / OpenRouter `json_schema` form).
 *
 * `strict: true` + `additionalProperties: false` + every key in `required`
 * (nullability is expressed with `["string", "null"]` type unions, not by
 * omitting the key). `items` has no `maxItems` — the line-item list is
 * unbounded on purpose.
 */
export const INVOICE_JSON_SCHEMA = {
  name: "invoice_extraction",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      invoice_number: { type: ["string", "null"] },
      invoice_date: { type: ["string", "null"] },
      due_date: { type: ["string", "null"] },
      supplier_name: { type: ["string", "null"] },
      supplier_address: { type: ["string", "null"] },
      supplier_ico: { type: ["string", "null"] },
      supplier_dic: { type: ["string", "null"] },
      supplier_ic_dph: { type: ["string", "null"] },
      customer_name: { type: ["string", "null"] },
      customer_address: { type: ["string", "null"] },
      customer_ico: { type: ["string", "null"] },
      customer_dic: { type: ["string", "null"] },
      customer_ic_dph: { type: ["string", "null"] },
      currency: { type: ["string", "null"] },
      subtotal: { type: ["number", "null"] },
      tax_total: { type: ["number", "null"] },
      total: { type: ["number", "null"] },
      payment_reference: { type: ["string", "null"] },
      iban: { type: ["string", "null"] },
      items: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            description: { type: ["string", "null"] },
            quantity: { type: ["number", "null"] },
            unit: { type: ["string", "null"] },
            unit_price: { type: ["number", "null"] },
            unit_price_includes_vat: { type: ["boolean", "null"] },
            tax_rate: { type: ["number", "null"] },
            line_net: { type: ["number", "null"] },
            line_vat: { type: ["number", "null"] },
            line_gross: { type: ["number", "null"] },
          },
          required: [
            "description",
            "quantity",
            "unit",
            "unit_price",
            "unit_price_includes_vat",
            "tax_rate",
            "line_net",
            "line_vat",
            "line_gross",
          ],
        },
      },
    },
    required: [
      "invoice_number",
      "invoice_date",
      "due_date",
      "supplier_name",
      "supplier_address",
      "supplier_ico",
      "supplier_dic",
      "supplier_ic_dph",
      "customer_name",
      "customer_address",
      "customer_ico",
      "customer_dic",
      "customer_ic_dph",
      "currency",
      "subtotal",
      "tax_total",
      "total",
      "payment_reference",
      "iban",
      "items",
    ],
  },
} as const;

/**
 * One invoice line, captured as printed.
 *
 * Slovak and Czech invoicing systems disagree on which line columns they print:
 * some show a net unit price and a net line amount, others show tax-inclusive
 * prices and no net column at all. Rather than have the model normalise (which
 * means computing, and computing means rounding differences that cannot be told
 * apart from a misread), every printed column gets its own field and anything
 * the document does not print stays null. Deriving the missing values is the
 * deterministic validator's job.
 */
export type InvoiceItem = {
  description: string | null;
  quantity: number | null;
  /** Unit of measure as printed ("ks", "rol", "kg"), null when no unit column. */
  unit: string | null;
  /** Unit price exactly as printed, whether or not it includes tax. */
  unit_price: number | null;
  /** Whether `unit_price` is tax-inclusive, per the column header. */
  unit_price_includes_vat: boolean | null;
  tax_rate: number | null;
  /** Net line amount, if the document prints one. */
  line_net: number | null;
  /** Line tax amount, if the document prints one. */
  line_vat: number | null;
  /** Gross line amount, if the document prints one. */
  line_gross: number | null;
};

export type InvoiceExtraction = {
  invoice_number: string | null;
  invoice_date: string | null;
  due_date: string | null;
  supplier_name: string | null;
  supplier_address: string | null;
  /** Company registration number (SK/CZ IČO). */
  supplier_ico: string | null;
  /** Tax identification number (SK/CZ DIČ). */
  supplier_dic: string | null;
  /** VAT identification number (SK IČ DPH, EU VAT number). */
  supplier_ic_dph: string | null;
  customer_name: string | null;
  customer_address: string | null;
  customer_ico: string | null;
  customer_dic: string | null;
  customer_ic_dph: string | null;
  currency: string | null;
  subtotal: number | null;
  tax_total: number | null;
  total: number | null;
  payment_reference: string | null;
  iban: string | null;
  items: InvoiceItem[];
};

/* ------------------------------------------------------------------ prompt -- */

const SYSTEM_PROMPT = `You extract structured data from invoice document images.

You are given one or more page images. ALL supplied pages belong to the SAME invoice / document — treat them as one document, not several.

Rules:
- Inspect every supplied page image before you answer.
- Extract every field that is visibly present on the document.
- Extract EVERY visible invoice line item, in the order it appears. If the item table continues across pages, include the rows from all pages.
- Never invent, guess or infer a value that is not visible. If a field cannot be reliably determined from the document, return null for it.
- null means the value is absent or unreadable. If the document explicitly prints a zero — a "0 %" / "0,00" tax rate, a zero amount — return the number 0, not null.
- Each party can carry up to three separate identifiers. THE PRINTED LABEL DECIDES which field a value goes into — never re-file a value because of how it looks:
  - *_ico <- the company registration number, the party's ID in the national business register (labelled IČO, IČ, or the local equivalent).
  - *_dic <- the tax identification number (labelled DIČ or the local equivalent).
  - *_ic_dph <- the VAT identification number (labelled IČ DPH, VAT ID, USt-IdNr, or the local equivalent).
  A value carrying a country prefix still goes under its own printed label: if the document says "DIČ: SK2020355029", then *_dic is "SK2020355029" and *_ic_dph is null — even though the value looks like a VAT number. A label the document does not print is null; never fill one field from another, and never repeat one value in two fields. Copy each value exactly, prefix included.
- An address is printed over several lines. Put it in the address field as ONE line, joining the parts in the order they are printed with a comma and a space. Never emit a line break inside any field.
- Preserve invoice numbers exactly as printed.
- Preserve the IBAN exactly as printed (do not alter, reorder or drop characters).
- Preserve dates as accurately as they are printed.
- Preserve all text exactly as printed, character for character, including every accent, diacritic and non-ASCII letter in whatever language the document uses. Never transliterate, romanise or strip accents from names, addresses, payment terms, item descriptions or any other text field. An accented letter dropped to its bare form is a misread, not a simplification.
- Never correct the document. Copy misspellings, typos, archaic or dialect wording, inconsistent punctuation, odd capitalisation and abbreviations exactly as they appear, even when you are certain of the intended word and even when the same term is written differently elsewhere on the same invoice. Expanding an abbreviation or fixing a spelling changes the record and counts as an extraction error.
- Set "currency" from the currency the invoice is payable in, taken from any code or symbol shown on it — beside the totals, in the amount-due box, or in a statement of which currency the amounts are in. Output the ISO 4217 code. An invoice may also show a converted tax summary in a second currency; the currency of the amounts in the item table and the amount due is the one to report.
- Distinguish the subtotal (net amount, before tax), the tax / VAT total, and the final total (gross amount).
- Line amounts: read the item table's column headers, decide what each money column means, and copy only the columns that are actually there. Never derive one line field from another.
  - "line_net" <- the column holding the line amount BEFORE tax.
  - "line_vat" <- the column holding the tax amount FOR THAT LINE.
  - "line_gross" <- the column holding the line amount INCLUDING tax.
  Headers differ by country, language and accounting system, and are often abbreviated. Identify each column by what it means in the table, not by matching a remembered wording. A column the document does not print is null for every line — most invoices print only two of these three. Do not compute a missing one, do not copy a value into two fields, and do not take a value from the tax summary table to fill a line field.
- "unit_price" is the unit price exactly as printed, whatever it includes. Read the unit-price column header and decide "unit_price_includes_vat" from its wording, treating the two answers as equally expected:
  - true when the header, or a sentence about how the invoice is priced, says the price INCLUDES tax.
  - false when it says the price EXCLUDES tax. A header that carries a "without tax" qualifier is stating this just as plainly as one that says "with tax" — do not leave it null because the statement is a negative one.
  - null ONLY when the header names no tax treatment at all, saying merely "price" or "unit price".
  Never settle it by comparing the numbers: the same neutral header means net on one system's invoice and gross on another's, and resolving that is not your job.
- Do not expect the line columns to be arithmetically consistent. Some invoices are priced from round tax-inclusive amounts, so the printed unit price is a rounded figure and quantity × unit_price can differ from the printed line amount. Copy every number exactly as printed; never adjust one to make it agree with another.
- Preserve numeric values accurately. In the output use a dot as the decimal separator and no thousands separators.
- Never merge unrelated line items. Never summarise several rows into one item. Never limit the number of line items to an assumed row count.
- Source fidelity matters more than filling every field.

Return exactly ONE invoice object for the whole document. A multi-page invoice is still one invoice — never split pages into separate invoices, and never return a JSON array.

Return only the JSON described by the response schema.`;

/* ------------------------------------------------------------------- error -- */

export type QwenErrorKind =
  | "missing-api-key"
  | "auth"
  | "insufficient-credit" // the API key's balance cannot cover the request
  | "api-error"
  | "network"
  | "timeout"
  | "invalid-response" // response envelope was not the expected OpenAI shape
  | "refusal" // model explicitly refused
  | "empty-response" // choice had no text content (often reasoning-token exhaustion)
  | "invalid-json" // content present but not parseable as JSON
  | "wrong-structure" // valid JSON, but not one invoice object with an items[] array
  | "structured-output"; // provider signalled the json_schema itself was unusable

export class QwenError extends Error {
  readonly kind: QwenErrorKind;
  readonly status?: number;

  constructor(
    kind: QwenErrorKind,
    message: string,
    options: { cause?: unknown; status?: number } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "QwenError";
    this.kind = kind;
    this.status = options.status;
  }
}

/* ------------------------------------------------------------------ result -- */

export type QwenUsage = {
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  /** OpenRouter credit cost for the call, when the API reports it. */
  cost: number | null;
};

export type QwenResult = {
  invoice: InvoiceExtraction;
  /** Model slug echoed back by the API (falls back to the requested slug). */
  model: string;
  usage: QwenUsage;
  /** Wall-clock time of the OpenRouter request, in ms. */
  qwenMs: number;
  /** Exact model message content, kept verbatim for debugging. */
  rawContent: string;
  finishReason: string | null;
};

export type QwenPageImage = {
  pageNumber: number;
  /** `data:image/png;base64,...` */
  dataUrl: string;
};

/* -------------------------------------------------------------- extraction -- */

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function toNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * TEMP structural diagnostics for the OpenRouter/Qwen response.
 *
 * Inert unless `QWEN_DEBUG=1`. Logs response *shape* only — never the API key,
 * request headers, or the full invoice payload (content previews are capped at
 * 200 chars). Remove once the structured-output response shape is pinned down.
 */
function debugResponseShape(info: {
  status?: number;
  payload?: Record<string, unknown>;
  choice?: Record<string, unknown>;
  message?: Record<string, unknown>;
  rawContent?: string;
  parsed?: unknown;
  hasParsed?: boolean;
}): void {
  if (process.env.QWEN_DEBUG !== "1") return;
  const { status, payload, choice, message, rawContent, parsed, hasParsed } =
    info;
  const d: Record<string, unknown> = {};
  if (status !== undefined) d.httpStatus = status;
  if (payload) {
    d.topLevelKeys = Object.keys(payload);
    d.typeofChoices = Array.isArray(payload.choices)
      ? `array(len=${(payload.choices as unknown[]).length})`
      : typeof payload.choices;
    d.hasProviderErrorField = "error" in payload;
    d.usage = payload.usage ?? null;
  }
  if (choice) {
    d.choiceKeys = Object.keys(choice);
    d.finish_reason = choice.finish_reason ?? null;
    d.native_finish_reason = choice.native_finish_reason ?? null;
  }
  if (message) {
    d.messageKeys = Object.keys(message);
    const c = message.content;
    d.typeofContent = Array.isArray(c)
      ? `array(len=${(c as unknown[]).length})`
      : c === null
        ? "null"
        : typeof c;
    if (Array.isArray(c) && c.length > 0) {
      const first = c[0];
      d.firstContentPart =
        first && typeof first === "object"
          ? { keys: Object.keys(first), type: (first as Record<string, unknown>).type }
          : typeof first;
    }
    d.hasRefusal = message.refusal != null && message.refusal !== "";
    d.hasReasoningField = "reasoning" in message || "reasoning_content" in message;
    d.hasParsedField = "parsed" in message;
    d.hasAnnotationsField = "annotations" in message;
  }
  if (rawContent !== undefined) {
    d.rawContent = {
      isString: typeof rawContent === "string",
      length: rawContent.length,
      head200: rawContent.slice(0, 200),
      tail80: rawContent.length > 200 ? rawContent.slice(-80) : undefined,
    };
  }
  if (hasParsed) {
    d.typeofParsed = Array.isArray(parsed)
      ? `array(len=${(parsed as unknown[]).length})`
      : parsed === null
        ? "null"
        : typeof parsed;
    if (typeof parsed === "string") {
      const t = (parsed as string).trim();
      d.parsedString = {
        length: (parsed as string).length,
        head200: (parsed as string).slice(0, 200),
        looksLikeJsonObject: t.startsWith("{") && t.endsWith("}"),
        looksLikeJsonArray: t.startsWith("[") && t.endsWith("]"),
      };
    } else if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      d.parsedObjectKeys = Object.keys(parsed as Record<string, unknown>);
    }
  }
  console.error("[qwen:debug] response shape:\n" + JSON.stringify(d, null, 2));
}

/** Pull a human-readable message out of an OpenRouter error body. */
function providerErrorMessage(raw: string): string {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      const rec = parsed as Record<string, unknown>;
      const err = rec.error;
      if (err && typeof err === "object") {
        const m = (err as Record<string, unknown>).message;
        if (typeof m === "string") return m;
      }
      if (typeof rec.message === "string") return rec.message;
    }
  } catch {
    /* not JSON — fall through */
  }
  return raw.slice(0, 500);
}

/**
 * Send every rendered PNG page of one invoice to Qwen3.8 Max and return the
 * parsed structured result. Throws {@link QwenError} on any failure — never a
 * partial result, never an automatic retry.
 */
export async function extractInvoice(
  pages: QwenPageImage[],
): Promise<QwenResult> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new QwenError(
      "missing-api-key",
      "OPENROUTER_API_KEY is not set on the server.",
    );
  }
  if (pages.length === 0) {
    throw new QwenError("invalid-response", "No page images to send to Qwen.");
  }

  const content = [
    {
      type: "text" as const,
      text:
        `Extract the invoice data from the following ${pages.length} page ` +
        `image(s). All pages are the same invoice.`,
    },
    ...pages.map((p) => ({
      type: "image_url" as const,
      image_url: { url: p.dataUrl },
    })),
  ];

  const requestBody = {
    model: QWEN_MODEL,
    temperature: 0,
    // Bounded so OpenRouter does not pre-authorise the full 65536-token model
    // maximum. See MAX_OUTPUT_TOKENS.
    max_tokens: MAX_OUTPUT_TOKENS,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content },
    ],
    // Under QWEN_RAW both keys below are omitted, leaving a plain chat request.
    ...(RAW_MODE
      ? {}
      : {
          response_format: {
            type: "json_schema",
            json_schema: INVOICE_JSON_SCHEMA,
          },
          // Only route to a provider that natively supports the parameters we
          // send (here: `response_format` / structured outputs). Without this,
          // OpenRouter is free to pick a provider that accepts `json_schema`
          // but does not grammar-enforce it, which lets the model emit a
          // top-level JSON array instead of the schema's `type: "object"`
          // root. If no eligible provider exists the request fails loudly
          // rather than silently downgrading.
          provider: { require_parameters: true },
        }),
    // Ask OpenRouter to include the cost breakdown alongside token counts.
    usage: { include: true },
  };

  if (RAW_MODE) {
    console.warn(
      "[qwen] QWEN_RAW=1 — sending a plain chat request (no response_format, " +
        "no json_schema, no provider filter); a 1-element array response will " +
        "be unwrapped.",
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const startedAt = performance.now();

  // The abort timer must cover the body read too, not just `fetch()`:
  // OpenRouter returns headers + keep-alive whitespace within a few seconds,
  // then streams the real JSON body only once generation finishes (~70 s for
  // this reasoning model). A stalled body would otherwise hang forever.
  let res: Response;
  let rawText: string;
  try {
    res = await fetch(OPENROUTER_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        // Optional attribution headers — no secrets.
        "HTTP-Referer": "https://invoice-processing-lab.local",
        "X-Title": "Invoice Processing Lab",
      },
      body: JSON.stringify(requestBody),
    });
    rawText = await res.text();
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new QwenError(
        "timeout",
        `Qwen request timed out after ${TIMEOUT_MS} ms.`,
        { cause: err },
      );
    }
    throw new QwenError(
      "network",
      `Network error calling OpenRouter: ${msg(err)}`,
      { cause: err },
    );
  } finally {
    clearTimeout(timer);
  }

  // `qwenMs` = full request time (headers + generation + body), measured after
  // the body read so it is not just time-to-first-byte.
  const qwenMs = Math.round(performance.now() - startedAt);

  if (!res.ok) {
    const detail = providerErrorMessage(rawText);
    if (res.status === 401 || res.status === 403) {
      throw new QwenError(
        "auth",
        `OpenRouter authentication failed (HTTP ${res.status}): ${detail}`,
        { status: res.status },
      );
    }
    // 402 means the key's remaining balance cannot pre-authorise the request.
    // The provider's own wording talks about token budgets and links to the key
    // settings page, which reads like a bug to anyone who is only uploading an
    // invoice — so it is classified separately and explained in plain terms.
    if (res.status === 402) {
      throw new QwenError(
        "insufficient-credit",
        "The OpenRouter account does not have enough credit left to process " +
          "this invoice. Nothing is wrong with the document — top up the " +
          "account or raise the API key's spend limit and try again.",
        { status: res.status },
      );
    }
    throw new QwenError(
      "api-error",
      `OpenRouter API error (HTTP ${res.status}): ${detail}`,
      { status: res.status },
    );
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawText) as Record<string, unknown>;
  } catch (err) {
    throw new QwenError(
      "invalid-response",
      `OpenRouter returned a non-JSON body: ${rawText.slice(0, 300)}`,
      { cause: err },
    );
  }

  // OpenRouter can report an error object with an HTTP 200.
  if (payload.error && typeof payload.error === "object") {
    const errRec = payload.error as Record<string, unknown>;
    const detail =
      typeof errRec.message === "string"
        ? errRec.message
        : JSON.stringify(errRec);
    const code = errRec.code;
    if (code === 401 || code === 403) {
      throw new QwenError("auth", `OpenRouter authentication failed: ${detail}`);
    }
    throw new QwenError("api-error", `OpenRouter API error: ${detail}`);
  }

  const choices = payload.choices;
  const choice =
    Array.isArray(choices) && choices.length > 0
      ? (choices[0] as Record<string, unknown>)
      : null;
  if (!choice) {
    throw new QwenError(
      "invalid-response",
      "OpenRouter response contained no choices.",
    );
  }

  const finishReason =
    typeof choice.finish_reason === "string" ? choice.finish_reason : null;
  const message = (choice.message ?? {}) as Record<string, unknown>;

  if (typeof message.refusal === "string" && message.refusal.trim()) {
    throw new QwenError(
      "refusal",
      `Model refused the request: ${message.refusal}`,
    );
  }

  let rawContent = "";
  if (typeof message.content === "string") {
    rawContent = message.content;
  } else if (Array.isArray(message.content)) {
    rawContent = message.content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          const t = (part as Record<string, unknown>).text;
          return typeof t === "string" ? t : "";
        }
        return "";
      })
      .join("");
  }

  if (!rawContent.trim()) {
    throw new QwenError(
      "empty-response",
      `Model returned no text content (finish_reason=${finishReason ?? "unknown"}` +
        `${"reasoning" in message || "reasoning_content" in message ? "; a reasoning field was present, so the token budget may have been spent before the answer" : ""}).`,
    );
  }

  // The Alibaba provider on OpenRouter accepts `response_format: json_schema`
  // but only partly enforces it: measured behaviour is that the schema's
  // `properties` are honoured exactly, while the root `type: "object"` is not —
  // an image request comes back as `[{...}]`, a one-element wrapper around the
  // otherwise schema-conforming invoice. So `content` can also arrive fenced or
  // double-encoded; normalise all three.
  let text = rawContent.trim();
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) text = fence[1].trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    debugResponseShape({ status: res.status, payload, choice, message, rawContent });
    throw new QwenError(
      "invalid-json",
      `Model output is not valid JSON (finish_reason=${finishReason ?? "unknown"}). ` +
        `First 200 chars: ${text.slice(0, 200)}`,
    );
  }

  // Double-encoded: content is a JSON string whose value is itself the document.
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      /* leave as string — classified below */
    }
  }

  debugResponseShape({
    status: res.status,
    payload,
    choice,
    message,
    rawContent,
    parsed,
    hasParsed: true,
  });

  // A 1-element array is the same single invoice in a wrapper — unwrap it.
  // With exactly one element there is nothing to choose between, so this is a
  // shape correction, not a guess about which object is "the" invoice.
  // Two or more objects stay a hard error: that choice is not this code's to
  // make, and merging them would silently invent an invoice.
  if (Array.isArray(parsed) && parsed.length === 1) {
    console.warn("[qwen] unwrapping 1-element top-level array.");
    parsed = parsed[0];
  }

  if (Array.isArray(parsed)) {
    throw new QwenError(
      "wrong-structure",
      `Model returned a top-level JSON array of ${parsed.length} invoice ` +
        `object(s). This job expects exactly one invoice per PDF; the array ` +
        `was not merged or unwrapped (finish_reason=${finishReason ?? "unknown"}).`,
    );
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new QwenError(
      "wrong-structure",
      `Model returned valid JSON but the top-level value is ` +
        `${parsed === null ? "null" : `a JSON ${typeof parsed}`}, not a single ` +
        `invoice object (finish_reason=${finishReason ?? "unknown"}).`,
    );
  }
  if (!Array.isArray((parsed as Record<string, unknown>).items)) {
    const keys = Object.keys(parsed as Record<string, unknown>);
    throw new QwenError(
      "wrong-structure",
      `Model returned a JSON object without an "items" array. ` +
        `Keys present: ${keys.length ? keys.join(", ") : "(none)"}.`,
    );
  }

  const usageRaw = (payload.usage ?? {}) as Record<string, unknown>;
  const usage: QwenUsage = {
    prompt_tokens: toNumberOrNull(usageRaw.prompt_tokens),
    completion_tokens: toNumberOrNull(usageRaw.completion_tokens),
    total_tokens: toNumberOrNull(usageRaw.total_tokens),
    cost: toNumberOrNull(usageRaw.cost),
  };

  return {
    invoice: parsed as InvoiceExtraction,
    model: typeof payload.model === "string" ? payload.model : QWEN_MODEL,
    usage,
    qwenMs,
    rawContent,
    finishReason,
  };
}
