/**
 * Ground-truth evaluation: run the real extraction path over every fixture and
 * diff the result against a hand-verified expected value, field by field.
 *
 * The fixtures are the exam, never the answer key — the system prompt must stay
 * general. A change that raises the score by naming a specific invoice's column
 * headers has made the pipeline worse, not better, and this harness cannot tell
 * you that. Only the wording of the prompt can.
 *
 * Usage:
 *   node --experimental-strip-types --env-file=.env.local scripts/eval.ts [name...]
 *
 * With no arguments every fixture runs. Each name filters by fixture basename,
 * e.g. `javor` or `rdmoto-25oss00189`.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { renderPdfToPngPages, clampDpi } from "../app/lib/pdf-render.ts";
import {
  extractInvoice,
  RAW_MODE,
  INVOICE_JSON_SCHEMA,
  type InvoiceExtraction,
  type QwenPageImage,
} from "../app/lib/qwen.ts";

const FIXTURE_DIR = "test/fixtures";
const SOURCE_DIR = join(FIXTURE_DIR, "sources");

/** Cents-level tolerance: fixtures and model both carry 2-decimal money. */
const NUMERIC_TOLERANCE = 0.005;

type Fixture = {
  name: string;
  invoice: InvoiceExtraction;
};

type Diff = { field: string; expected: unknown; got: unknown };

/* ---------------------------------------------------------------- compare -- */

/**
 * Collapse whitespace runs so a fixture written with single spaces still
 * matches a document whose text layer carries double spaces. Everything else —
 * case, accents, punctuation — must match exactly.
 */
function normaliseText(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function valuesMatch(expected: unknown, got: unknown): boolean {
  if (expected === null || got === null) return expected === got;
  if (typeof expected === "number" && typeof got === "number") {
    return Math.abs(expected - got) <= NUMERIC_TOLERANCE;
  }
  if (typeof expected === "string" && typeof got === "string") {
    return normaliseText(expected) === normaliseText(got);
  }
  return expected === got;
}

const TOP_FIELDS = Object.keys(INVOICE_JSON_SCHEMA.schema.properties).filter(
  (k) => k !== "items",
);
const ITEM_FIELDS = Object.keys(
  INVOICE_JSON_SCHEMA.schema.properties.items.items.properties,
);

function compare(expected: InvoiceExtraction, got: InvoiceExtraction): Diff[] {
  const diffs: Diff[] = [];
  const e = expected as unknown as Record<string, unknown>;
  const g = got as unknown as Record<string, unknown>;

  for (const field of TOP_FIELDS) {
    if (!valuesMatch(e[field], g[field])) {
      diffs.push({ field, expected: e[field], got: g[field] });
    }
  }

  const eItems = expected.items ?? [];
  const gItems = got.items ?? [];
  if (eItems.length !== gItems.length) {
    diffs.push({
      field: "items.length",
      expected: eItems.length,
      got: gItems.length,
    });
  }

  // Compare the rows both sides have; a count mismatch is already reported.
  for (let i = 0; i < Math.min(eItems.length, gItems.length); i++) {
    const ei = eItems[i] as unknown as Record<string, unknown>;
    const gi = gItems[i] as unknown as Record<string, unknown>;
    for (const field of ITEM_FIELDS) {
      if (!valuesMatch(ei[field], gi[field])) {
        diffs.push({
          field: `items[${i}].${field}`,
          expected: ei[field],
          got: gi[field],
        });
      }
    }
  }

  return diffs;
}

/* ------------------------------------------------------------------ pages -- */

async function pagesFor(name: string): Promise<QwenPageImage[]> {
  const entries = await readdir(SOURCE_DIR);
  const source = entries.find((f) => f.replace(/\.[^.]+$/, "") === name);
  if (!source) {
    throw new Error(`no source file for fixture "${name}" in ${SOURCE_DIR}`);
  }
  const path = join(SOURCE_DIR, source);
  const data = new Uint8Array(await readFile(path));

  if (source.toLowerCase().endsWith(".png")) {
    // Already a page image (a scan) — feed it to the model unchanged.
    return [
      {
        pageNumber: 1,
        dataUrl: `data:image/png;base64,${Buffer.from(data).toString("base64")}`,
      },
    ];
  }

  const pages: QwenPageImage[] = [];
  for await (const event of renderPdfToPngPages(data, { dpi: clampDpi(null) })) {
    if (event.type === "page-rendered") {
      const { pageNumber, png } = event.page;
      pages.push({
        pageNumber,
        dataUrl: `data:image/png;base64,${Buffer.from(png).toString("base64")}`,
      });
    }
  }
  return pages;
}

/* ------------------------------------------------------------------- main -- */

function show(v: unknown): string {
  return typeof v === "string" ? JSON.stringify(v) : String(v);
}

if (RAW_MODE) {
  console.error(
    "QWEN_RAW=1 strips the JSON schema from the request, so field names are " +
      "the model's own and every fixture will fail. Set QWEN_RAW=0 and re-run.",
  );
  process.exit(2);
}

const filters = process.argv.slice(2);
const files = (await readdir(FIXTURE_DIR))
  .filter((f) => f.endsWith(".expected.json"))
  .filter((f) => filters.length === 0 || filters.some((q) => f.includes(q)))
  .sort();

if (files.length === 0) {
  console.error(`no fixtures matched ${filters.join(", ") || "(all)"}`);
  process.exit(2);
}

const fixtures: Fixture[] = [];
for (const file of files) {
  const parsed = JSON.parse(await readFile(join(FIXTURE_DIR, file), "utf8"));
  fixtures.push({
    name: file.replace(/\.expected\.json$/, ""),
    invoice: parsed.invoice as InvoiceExtraction,
  });
}

type Result = {
  name: string;
  status: "ok" | "error";
  fields: number;
  diffs: Diff[];
  cost: number;
  error?: string;
};

const results: Result[] = [];

for (const fixture of fixtures) {
  process.stdout.write(`\n${"=".repeat(72)}\n${fixture.name}\n${"=".repeat(72)}\n`);

  let pages: QwenPageImage[];
  try {
    pages = await pagesFor(fixture.name);
  } catch (err) {
    console.log(`  SKIP — ${err instanceof Error ? err.message : String(err)}`);
    continue;
  }
  console.log(`  ${pages.length} page image(s)`);

  let got: InvoiceExtraction;
  let cost = 0;
  try {
    const r = await extractInvoice(pages);
    got = r.invoice;
    cost = r.usage.cost ?? 0;
    console.log(
      `  extracted in ${(r.qwenMs / 1000).toFixed(1)} s, ` +
        `${r.usage.total_tokens ?? "?"} tokens, $${cost.toFixed(4)}`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`  FAILED — ${message}`);
    results.push({
      name: fixture.name,
      status: "error",
      fields: 0,
      diffs: [],
      cost: 0,
      error: message,
    });
    continue;
  }

  const diffs = compare(fixture.invoice, got);
  const fieldCount =
    TOP_FIELDS.length + (fixture.invoice.items?.length ?? 0) * ITEM_FIELDS.length;

  if (diffs.length === 0) {
    console.log(`  ✓ all ${fieldCount} fields match`);
  } else {
    console.log(`  ✕ ${diffs.length} of ${fieldCount} fields differ:`);
    for (const d of diffs) {
      console.log(`      ${d.field}`);
      console.log(`        expected: ${show(d.expected)}`);
      console.log(`        got     : ${show(d.got)}`);
    }
  }

  results.push({
    name: fixture.name,
    status: "ok",
    fields: fieldCount,
    diffs,
    cost,
  });
}

/* ---------------------------------------------------------------- summary -- */

console.log(`\n${"=".repeat(72)}\nSUMMARY\n${"=".repeat(72)}`);
let totalFields = 0;
let totalDiffs = 0;
let totalCost = 0;
let errors = 0;
for (const r of results) {
  totalCost += r.cost;
  if (r.status === "error") {
    errors++;
    console.log(`  ! ${r.name.padEnd(28)} DID NOT RUN — ${r.error}`);
    continue;
  }
  totalFields += r.fields;
  totalDiffs += r.diffs.length;
  const mark = r.diffs.length === 0 ? "✓" : "✕";
  console.log(
    `  ${mark} ${r.name.padEnd(28)} ${(r.fields - r.diffs.length)
      .toString()
      .padStart(3)}/${r.fields.toString().padEnd(3)} fields`,
  );
}
const pct = totalFields > 0 ? ((totalFields - totalDiffs) / totalFields) * 100 : 0;
console.log(
  `\n  ${totalFields - totalDiffs}/${totalFields} fields (${pct.toFixed(1)}%) ` +
    `over ${results.length - errors}/${results.length} fixtures, ` +
    `$${totalCost.toFixed(4)}`,
);
// A fixture that never ran is not a pass: the score above covers only the
// fixtures that produced an extraction.
if (errors > 0) {
  console.log(
    `  ${errors} fixture(s) did not run — the score above is not a full result.`,
  );
}
process.exit(totalDiffs === 0 && errors === 0 ? 0 : 1);
