/**
 * Connectivity probe: PDF -> PNG pages -> Qwen, with NO structured output.
 *
 * This deliberately mirrors what the Qwen web chat does: the images and the
 * prompt go up, whatever comes back is printed verbatim. No `response_format`,
 * no `json_schema`, no parsing, no shape validation — so a run can only fail on
 * rendering, transport, or the model itself, never on the answer's structure.
 *
 * Usage:
 *   node --experimental-strip-types --env-file=.env.local \
 *     scripts/qwen-raw.ts <invoice.pdf> [dpi]
 */

import { readFile } from "node:fs/promises";
import { renderPdfToPngPages, clampDpi } from "../app/lib/pdf-render.ts";
import { QWEN_MODEL, MAX_OUTPUT_TOKENS } from "../app/lib/qwen.ts";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const TIMEOUT_MS = 240_000;

/**
 * Same extraction rules as the app's system prompt, minus every instruction
 * about the response envelope: with no schema attached, the output shape is the
 * model's business and this script's job is only to show it.
 */
const PROMPT = `You extract structured data from invoice document images.

You are given one or more page images. ALL supplied pages belong to the SAME invoice / document — treat them as one document, not several.

Rules:
- Inspect every supplied page image before you answer.
- Extract every field that is visibly present on the document.
- Extract EVERY visible invoice line item, in the order it appears.
- Never invent, guess or infer a value that is not visible. If a field cannot be reliably determined from the document, leave it empty.
- Preserve invoice numbers and the IBAN exactly as printed.
- Distinguish the subtotal (net), the tax / VAT total, and the final total (gross).
- Use a dot as the decimal separator and no thousands separators.

Return the invoice data as JSON.`;

const [pdfPath, dpiArg] = process.argv.slice(2);
if (!pdfPath) {
  console.error("usage: qwen-raw.ts <invoice.pdf> [dpi]");
  process.exit(2);
}

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  console.error("OPENROUTER_API_KEY is not set (try --env-file=.env.local).");
  process.exit(2);
}

const dpi = clampDpi(dpiArg);
const data = new Uint8Array(await readFile(pdfPath));

const images: { pageNumber: number; dataUrl: string }[] = [];
let totalPngBytes = 0;
for await (const event of renderPdfToPngPages(data, { dpi })) {
  if (event.type === "pdf-parsed") {
    console.log(`pdf: ${event.pageCount} page(s) @ ${dpi} DPI`);
  } else if (event.type === "page-rendered") {
    const { pageNumber, width, height, png } = event.page;
    totalPngBytes += png.length;
    console.log(
      `  page ${pageNumber}: ${width}x${height}, ${(png.length / 1024).toFixed(0)} KB PNG`,
    );
    images.push({
      pageNumber,
      dataUrl: `data:image/png;base64,${Buffer.from(png).toString("base64")}`,
    });
  }
}
console.log(`png total: ${(totalPngBytes / 1024 / 1024).toFixed(2)} MB\n`);

const requestBody = {
  model: QWEN_MODEL,
  temperature: 0,
  max_tokens: MAX_OUTPUT_TOKENS,
  messages: [
    {
      role: "user",
      content: [
        {
          type: "text",
          text:
            `${PROMPT}\n\nHere are the ${images.length} page image(s) of the ` +
            `invoice.`,
        },
        ...images.map((p) => ({
          type: "image_url",
          image_url: { url: p.dataUrl },
        })),
      ],
    },
  ],
  usage: { include: true },
};

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
const startedAt = performance.now();

let res: Response;
let rawText: string;
try {
  res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(requestBody),
    signal: controller.signal,
  });
  rawText = await res.text();
} finally {
  clearTimeout(timer);
}
const elapsedMs = Math.round(performance.now() - startedAt);

console.log(`HTTP ${res.status} in ${(elapsedMs / 1000).toFixed(1)} s\n`);

if (!res.ok) {
  console.log(rawText.slice(0, 2000));
  process.exit(1);
}

const payload = JSON.parse(rawText);
const choice = payload.choices?.[0];
const content = choice?.message?.content;

console.log("provider:", payload.provider ?? "(not reported)");
console.log("model:", payload.model ?? QWEN_MODEL);
console.log("finish_reason:", choice?.finish_reason ?? "(none)");
console.log("native_finish_reason:", choice?.native_finish_reason ?? "(none)");
console.log("usage:", JSON.stringify(payload.usage ?? null));
console.log(
  "content type:",
  Array.isArray(content) ? `array(len=${content.length})` : typeof content,
);

console.log("\n----- RAW MODEL OUTPUT -----");
console.log(
  typeof content === "string" ? content : JSON.stringify(content, null, 2),
);
console.log("----- END RAW OUTPUT -----");

// Report the shape without acting on it: this probe never unwraps or rejects.
if (typeof content === "string") {
  const stripped = content.trim().replace(/^```(?:json)?\s*|\s*```$/gi, "").trim();
  try {
    const parsed = JSON.parse(stripped);
    console.log(
      "\nparses as JSON:",
      Array.isArray(parsed)
        ? `top-level ARRAY of ${parsed.length}`
        : `top-level ${parsed === null ? "null" : typeof parsed}`,
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? `— keys: ${Object.keys(parsed).join(", ")}`
        : "",
    );
  } catch {
    console.log("\nparses as JSON: no (free-form text)");
  }
}
