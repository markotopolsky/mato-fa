import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { validateInvoice } from "../app/lib/validate.ts";

const FIXTURE_DIR = "test/fixtures";

/* ------------------------------------------------------- structural cases -- */

test("a non-object is an error, not a throw", () => {
  for (const bad of [null, "x", 7, [], undefined]) {
    const r = validateInvoice(bad);
    assert.equal(r.valid, false);
    assert.ok(r.errors.length > 0);
  }
});

test("items must be an array", () => {
  const r = validateInvoice({ items: {} });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.code === "items-not-array"));
});

test("a wrong field type is an error, a null one is not", () => {
  const typed = validateInvoice({ subtotal: "100", items: [] });
  assert.ok(typed.errors.some((e) => e.code === "field-type"));

  const absent = validateInvoice({ subtotal: null, items: [] });
  assert.equal(absent.valid, true);
  assert.ok(absent.warnings.some((w) => w.code === "field-missing"));
});

test("missing IBAN is a warning, never an error", () => {
  const r = validateInvoice({ iban: null, items: [] });
  assert.equal(r.valid, true);
  assert.ok(r.warnings.some((w) => w.field === "iban"));
});

/* -------------------------------------------------------------- arithmetic -- */

/**
 * Warnings other than "this header field was not filled in". The minimal
 * objects below carry only the fields a given arithmetic rule needs, so their
 * absent-field warnings say nothing about the rule under test.
 */
function arithmeticWarnings(r: { warnings: { code: string }[] }): string[] {
  return r.warnings.filter((w) => w.code !== "field-missing").map((w) => w.code);
}

const LINE = {
  description: "A",
  quantity: 1,
  unit: null,
  unit_price: 100,
  unit_price_includes_vat: false,
  tax_rate: 23,
  line_net: 100,
  line_vat: 23,
  line_gross: 123,
};

test("subtotal + tax = total mismatch is a warning", () => {
  const r = validateInvoice({
    subtotal: 100,
    tax_total: 23,
    total: 200,
    items: [LINE],
  });
  assert.equal(r.valid, true);
  assert.ok(r.warnings.some((w) => w.code === "totals-mismatch"));
});

test("line net amounts are checked against the subtotal", () => {
  const r = validateInvoice({
    subtotal: 999,
    tax_total: 23,
    total: 1022,
    items: [LINE],
  });
  assert.ok(r.warnings.some((w) => w.code === "lines-vs-subtotal"));
});

test("a gross-priced invoice's rounding gap is tolerated", () => {
  // Real values from invoice 20260192: the seller priced from a round gross
  // total, so 4 × 154.47 = 617.88 while the document prints 617.89.
  const r = validateInvoice({
    subtotal: 617.89,
    tax_total: 142.11,
    total: 760,
    items: [
      {
        ...LINE,
        quantity: 4,
        unit_price: 154.47,
        unit_price_includes_vat: false,
        line_net: 617.89,
        line_vat: 142.11,
        line_gross: 760,
      },
    ],
  });
  assert.equal(r.valid, true);
  assert.deepEqual(
    arithmeticWarnings(r),
    [],
    `unexpected warnings: ${r.warnings.map((w) => w.message).join(" | ")}`,
  );
});

test("a genuine quantity x unit price error is still caught", () => {
  const r = validateInvoice({
    subtotal: 500,
    tax_total: 115,
    total: 615,
    items: [
      {
        ...LINE,
        quantity: 4,
        unit_price: 154.47,
        line_net: 500,
        line_vat: 115,
        line_gross: 615,
      },
    ],
  });
  assert.ok(r.warnings.some((w) => w.code === "line-product"));
});

test("net is derived when the document prints only gross and a rate", () => {
  // Invoice 26570 is priced in tax-inclusive amounts and has no net column.
  const r = validateInvoice({
    subtotal: 23,
    tax_total: 5.29,
    total: 28.29,
    items: [
      {
        description: "Sanitiz Alkoholova dezinfekcia 5L",
        quantity: 2,
        unit: null,
        unit_price: 14.15,
        unit_price_includes_vat: true,
        tax_rate: 23,
        line_net: null,
        line_vat: null,
        line_gross: 28.29,
      },
    ],
  });
  assert.equal(r.valid, true);
  const line = r.derived.lines[0];
  assert.ok(line.net !== null && Math.abs(line.net - 23) < 0.01);
  assert.ok(line.computed.includes("net"));
  assert.deepEqual(
    arithmeticWarnings(r),
    [],
    `unexpected warnings: ${r.warnings.map((w) => w.message).join(" | ")}`,
  );
});

test("an unstated unit-price side is reported as info, not a warning", () => {
  const r = validateInvoice({
    subtotal: 297,
    tax_total: 68.31,
    total: 365.31,
    items: [
      {
        ...LINE,
        quantity: 300,
        unit_price: 0.99,
        unit_price_includes_vat: null,
        line_net: 297,
        line_vat: 68.31,
        line_gross: 365.31,
      },
    ],
  });
  assert.equal(r.valid, true);
  assert.deepEqual(arithmeticWarnings(r), []);
  assert.ok(r.infos.some((i) => i.code === "line-unit-price-side"));
});

test("a line with no amount at all is a warning", () => {
  const r = validateInvoice({
    items: [{ ...LINE, line_net: null, line_vat: null, line_gross: null, tax_rate: null }],
  });
  assert.ok(r.warnings.some((w) => w.code === "line-no-amount"));
});

/* ---------------------------------------------------------------- fixtures -- */

// Every fixture is a hand-verified reading of a real invoice, so the validator
// must accept all of them. A new error here means either the validator is wrong
// or a fixture is — both worth stopping for.
const fixtures = readdirSync(FIXTURE_DIR).filter((f) =>
  f.endsWith(".expected.json"),
);

assert.ok(fixtures.length > 0, "no fixtures found");

for (const file of fixtures) {
  test(`fixture validates: ${file.replace(".expected.json", "")}`, () => {
    const parsed = JSON.parse(readFileSync(join(FIXTURE_DIR, file), "utf8"));
    const r = validateInvoice(parsed.invoice);
    assert.equal(
      r.valid,
      true,
      `errors: ${r.errors.map((e) => e.message).join(" | ")}`,
    );
    assert.deepEqual(
      r.warnings.map((w) => w.message),
      [],
      `unexpected warnings in ${file}`,
    );
  });
}
