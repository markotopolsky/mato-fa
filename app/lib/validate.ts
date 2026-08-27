/**
 * Phase 3 — deterministic validation of an extracted invoice.
 *
 * No model, no network, no randomness: the same invoice always produces the
 * same findings. This is what replaces asking a chat model whether an
 * extraction "looks right" — three chat models grading the same JSON produced
 * three different verdicts, none of them repeatable.
 *
 * Two rules shape everything here:
 *
 * 1. Extracted values are NEVER modified. Anything this module works out is
 *    reported separately under `derived`; the invoice itself is read-only.
 * 2. A missing value is not automatically a failure. Only a structural or type
 *    defect is an `error`; an inconsistency or an absent-but-expected field is
 *    a `warning`, and an explained discrepancy is `info`.
 */

import type { InvoiceExtraction, InvoiceItem } from "./qwen";

export type Severity = "error" | "warning" | "info";

export type Finding = {
  severity: Severity;
  /** Stable machine code, safe to match on. */
  code: string;
  /** Dotted path into the invoice, when the finding is about one field. */
  field?: string;
  message: string;
};

/**
 * Line amounts worked out from the ones the document did print.
 *
 * Invoices that quote tax-inclusive prices often print no net column at all, so
 * the net amount has to be computed before any total can be cross-checked.
 * These values are advisory: they never replace an extracted field.
 */
export type DerivedLine = {
  index: number;
  net: number | null;
  vat: number | null;
  gross: number | null;
  /** Which of the three were computed rather than read off the document. */
  computed: ("net" | "vat" | "gross")[];
};

export type ValidationResult = {
  /** True when there are no `error` findings. Warnings do not clear this flag. */
  valid: boolean;
  findings: Finding[];
  errors: Finding[];
  warnings: Finding[];
  infos: Finding[];
  derived: {
    lines: DerivedLine[];
    /** Sum of the per-line net amounts, printed or derived. */
    linesNet: number | null;
    linesVat: number | null;
    linesGross: number | null;
  };
};

/* ------------------------------------------------------------- tolerances -- */

/** A single rounded-to-cent value can be half a cent off in either direction. */
const CENT = 0.005;

/**
 * Tolerance for a sum of `n` rounded values: each contributes up to half a
 * cent of rounding, and a floor keeps a one-line invoice from being held to an
 * impossible standard.
 */
function sumTolerance(n: number): number {
  return Math.max(0.01, n * CENT);
}

/**
 * Tolerance for `quantity × unit_price` against a printed line amount.
 *
 * The printed unit price is itself rounded, and that rounding is multiplied by
 * the quantity: an invoice priced from a round gross total shows a unit price
 * of net/qty rounded to two decimals, so a 4-unit line can legitimately be two
 * cents away from the product. Verified on a real invoice where the document
 * prints 617.89 while 4 × 154.47 is 617.88.
 */
function productTolerance(quantity: number): number {
  return Math.max(0.01, Math.abs(quantity) * CENT);
}

/**
 * Compare within a tolerance, with a slack term for binary floating point.
 *
 * Without it a difference that is exactly the tolerance fails: 2 × 14.15 is
 * 28.300000000000001 and the printed line total is 28.289999999999999, so the
 * gap computes as 0.0100000000000016 against a 0.01 tolerance. That is a real
 * invoice (26570) and a correct extraction, so the comparison must not reject
 * it on representation error alone.
 */
function close(a: number, b: number, tolerance: number): boolean {
  return Math.abs(a - b) <= tolerance + 1e-9;
}

/** Round to cents for display in a message, without touching stored values. */
function money(n: number): string {
  return n.toFixed(2);
}

/* ------------------------------------------------------------ type guards -- */

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * A field is well-typed when it is null (absent) or the expected type. Absence
 * is reported separately, as a warning, never as a type error.
 */
function checkType(
  findings: Finding[],
  field: string,
  value: unknown,
  expected: "string" | "number" | "boolean",
): void {
  if (value === null || value === undefined) return;
  if (expected === "number") {
    if (!isFiniteNumber(value)) {
      findings.push({
        severity: "error",
        code: "field-type",
        field,
        message: `${field} must be a finite number or null, got ${JSON.stringify(value)}.`,
      });
    }
    return;
  }
  if (typeof value !== expected) {
    findings.push({
      severity: "error",
      code: "field-type",
      field,
      message: `${field} must be a ${expected} or null, got ${typeof value}.`,
    });
  }
}

/** Fields whose absence is worth flagging, but which are not always printed. */
const EXPECTED_PRESENT: { field: keyof InvoiceExtraction; label: string }[] = [
  { field: "invoice_number", label: "invoice number" },
  { field: "invoice_date", label: "issue date" },
  { field: "due_date", label: "due date" },
  { field: "supplier_name", label: "supplier name" },
  { field: "customer_name", label: "customer name" },
  { field: "currency", label: "currency" },
  { field: "total", label: "total" },
  { field: "iban", label: "IBAN" },
];

/* ------------------------------------------------------------- line logic -- */

/**
 * Work out a line's net / tax / gross from whichever of the three the document
 * printed, plus the tax rate. Nothing is invented: with fewer than two knowns
 * (or one known and a rate) the missing values stay null.
 */
function deriveLine(item: InvoiceItem, index: number): DerivedLine {
  const printedNet = isFiniteNumber(item.line_net) ? item.line_net : null;
  const printedVat = isFiniteNumber(item.line_vat) ? item.line_vat : null;
  const printedGross = isFiniteNumber(item.line_gross) ? item.line_gross : null;
  const rate = isFiniteNumber(item.tax_rate) ? item.tax_rate : null;

  let net = printedNet;
  let vat = printedVat;
  let gross = printedGross;
  const computed: DerivedLine["computed"] = [];

  // Two of the three determine the third exactly.
  if (net === null && vat !== null && gross !== null) {
    net = gross - vat;
    computed.push("net");
  }
  if (vat === null && net !== null && gross !== null) {
    vat = gross - net;
    computed.push("vat");
  }
  if (gross === null && net !== null && vat !== null) {
    gross = net + vat;
    computed.push("gross");
  }

  // One value plus the rate determines the rest.
  if (rate !== null) {
    const factor = 1 + rate / 100;
    if (net === null && gross !== null && factor !== 0) {
      net = gross / factor;
      computed.push("net");
    }
    if (gross === null && net !== null) {
      gross = net * factor;
      computed.push("gross");
    }
    if (vat === null && net !== null) {
      vat = (net * rate) / 100;
      computed.push("vat");
    }
  }

  return { index, net, vat, gross, computed };
}

function checkLine(
  findings: Finding[],
  item: InvoiceItem,
  derived: DerivedLine,
  i: number,
): void {
  const at = `items[${i}]`;

  checkType(findings, `${at}.description`, item.description, "string");
  checkType(findings, `${at}.unit`, item.unit, "string");
  checkType(findings, `${at}.quantity`, item.quantity, "number");
  checkType(findings, `${at}.unit_price`, item.unit_price, "number");
  checkType(
    findings,
    `${at}.unit_price_includes_vat`,
    item.unit_price_includes_vat,
    "boolean",
  );
  checkType(findings, `${at}.tax_rate`, item.tax_rate, "number");
  checkType(findings, `${at}.line_net`, item.line_net, "number");
  checkType(findings, `${at}.line_vat`, item.line_vat, "number");
  checkType(findings, `${at}.line_gross`, item.line_gross, "number");

  if (!item.description || !item.description.trim()) {
    findings.push({
      severity: "warning",
      code: "line-no-description",
      field: `${at}.description`,
      message: `Line ${i + 1} has no description.`,
    });
  }

  if (
    item.line_net === null &&
    item.line_vat === null &&
    item.line_gross === null
  ) {
    findings.push({
      severity: "warning",
      code: "line-no-amount",
      field: at,
      message: `Line ${i + 1} carries no amount at all (net, tax and gross are all null).`,
    });
    return;
  }

  // net + tax = gross, when the document printed all three itself.
  if (
    isFiniteNumber(item.line_net) &&
    isFiniteNumber(item.line_vat) &&
    isFiniteNumber(item.line_gross) &&
    !close(item.line_net + item.line_vat, item.line_gross, 0.01)
  ) {
    findings.push({
      severity: "warning",
      code: "line-net-vat-gross",
      field: at,
      message:
        `Line ${i + 1}: net ${money(item.line_net)} + tax ${money(item.line_vat)} ` +
        `= ${money(item.line_net + item.line_vat)}, but the line total is ` +
        `${money(item.line_gross)}.`,
    });
  }

  // The printed tax amount against the printed rate.
  if (
    isFiniteNumber(item.line_net) &&
    isFiniteNumber(item.line_vat) &&
    isFiniteNumber(item.tax_rate) &&
    !close((item.line_net * item.tax_rate) / 100, item.line_vat, 0.01)
  ) {
    findings.push({
      severity: "warning",
      code: "line-vat-rate",
      field: `${at}.line_vat`,
      message:
        `Line ${i + 1}: ${item.tax_rate}% of ${money(item.line_net)} is ` +
        `${money((item.line_net * item.tax_rate) / 100)}, but the line tax is ` +
        `${money(item.line_vat)}.`,
    });
  }

  // quantity × unit_price against the line amount the unit price belongs to.
  if (isFiniteNumber(item.quantity) && isFiniteNumber(item.unit_price)) {
    const product = item.quantity * item.unit_price;
    const tolerance = productTolerance(item.quantity);
    const inclusive = item.unit_price_includes_vat;

    // With `unit_price_includes_vat` null the document did not say which side
    // the unit price is on, so matching either amount is a pass — and which one
    // it matched is worth reporting, because it answers the question the
    // document left open.
    const target =
      inclusive === true
        ? { value: derived.gross, label: "gross" as const }
        : inclusive === false
          ? { value: derived.net, label: "net" as const }
          : null;

    if (target) {
      if (
        isFiniteNumber(target.value) &&
        !close(product, target.value, tolerance)
      ) {
        findings.push({
          severity: "warning",
          code: "line-product",
          field: at,
          message:
            `Line ${i + 1}: ${item.quantity} × ${item.unit_price} = ` +
            `${money(product)}, but the ${target.label} line amount is ` +
            `${money(target.value)}.`,
        });
      }
    } else {
      const matchesNet =
        isFiniteNumber(derived.net) && close(product, derived.net, tolerance);
      const matchesGross =
        isFiniteNumber(derived.gross) &&
        close(product, derived.gross, tolerance);
      if (matchesNet || matchesGross) {
        findings.push({
          severity: "info",
          code: "line-unit-price-side",
          field: `${at}.unit_price`,
          message:
            `Line ${i + 1}: the document does not say whether the unit price ` +
            `includes tax; ${item.quantity} × ${item.unit_price} matches the ` +
            `${matchesNet ? "net" : "gross"} line amount.`,
        });
      } else if (isFiniteNumber(derived.net) || isFiniteNumber(derived.gross)) {
        findings.push({
          severity: "warning",
          code: "line-product",
          field: at,
          message:
            `Line ${i + 1}: ${item.quantity} × ${item.unit_price} = ` +
            `${money(product)}, which matches neither the net ` +
            `(${derived.net === null ? "—" : money(derived.net)}) nor the gross ` +
            `(${derived.gross === null ? "—" : money(derived.gross)}) line amount.`,
        });
      }
    }
  }

  if (derived.computed.length > 0) {
    findings.push({
      severity: "info",
      code: "line-derived",
      field: at,
      message:
        `Line ${i + 1}: the document prints no ${derived.computed.join("/")} ` +
        `column; the value was computed for checking and is not part of the ` +
        `extraction.`,
    });
  }
}

/* ------------------------------------------------------------------ entry -- */

/**
 * Validate one extracted invoice. Never throws: a malformed input produces
 * `error` findings rather than an exception, so a bad extraction is reportable
 * instead of fatal.
 */
export function validateInvoice(invoice: unknown): ValidationResult {
  const findings: Finding[] = [];
  const empty = { lines: [], linesNet: null, linesVat: null, linesGross: null };

  if (invoice === null || typeof invoice !== "object" || Array.isArray(invoice)) {
    findings.push({
      severity: "error",
      code: "not-an-object",
      message: `Expected a single invoice object, got ${
        Array.isArray(invoice) ? "an array" : invoice === null ? "null" : typeof invoice
      }.`,
    });
    return finish(findings, empty);
  }

  const inv = invoice as InvoiceExtraction;

  for (const field of [
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
    "payment_reference",
    "iban",
  ] as const) {
    checkType(findings, field, inv[field], "string");
  }
  for (const field of ["subtotal", "tax_total", "total"] as const) {
    checkType(findings, field, inv[field], "number");
  }

  for (const { field, label } of EXPECTED_PRESENT) {
    if (inv[field] === null || inv[field] === undefined) {
      findings.push({
        severity: "warning",
        code: "field-missing",
        field,
        message: `No ${label} was extracted.`,
      });
    }
  }

  if (!Array.isArray(inv.items)) {
    findings.push({
      severity: "error",
      code: "items-not-array",
      field: "items",
      message: `"items" must be an array, got ${typeof inv.items}.`,
    });
    return finish(findings, empty);
  }

  if (inv.items.length === 0) {
    findings.push({
      severity: "warning",
      code: "items-empty",
      field: "items",
      message: "The invoice has no line items.",
    });
  }

  const lines: DerivedLine[] = [];
  for (let i = 0; i < inv.items.length; i++) {
    const item = inv.items[i];
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      findings.push({
        severity: "error",
        code: "item-not-an-object",
        field: `items[${i}]`,
        message: `Line ${i + 1} is not an object.`,
      });
      continue;
    }
    const derived = deriveLine(item, i);
    lines.push(derived);
    checkLine(findings, item, derived, i);
  }

  // Sum a column only when every line contributes to it; a partial sum would
  // silently under-report and look like a mismatch in the totals below.
  const sumOf = (pick: (l: DerivedLine) => number | null): number | null => {
    if (lines.length === 0) return null;
    let acc = 0;
    for (const line of lines) {
      const v = pick(line);
      if (!isFiniteNumber(v)) return null;
      acc += v;
    }
    return acc;
  };

  const derived = {
    lines,
    linesNet: sumOf((l) => l.net),
    linesVat: sumOf((l) => l.vat),
    linesGross: sumOf((l) => l.gross),
  };

  const tol = sumTolerance(lines.length);

  if (
    isFiniteNumber(inv.subtotal) &&
    isFiniteNumber(inv.tax_total) &&
    isFiniteNumber(inv.total) &&
    !close(inv.subtotal + inv.tax_total, inv.total, 0.01)
  ) {
    findings.push({
      severity: "warning",
      code: "totals-mismatch",
      field: "total",
      message:
        `subtotal ${money(inv.subtotal)} + tax ${money(inv.tax_total)} = ` +
        `${money(inv.subtotal + inv.tax_total)}, but the total is ${money(inv.total)}.`,
    });
  }

  if (
    isFiniteNumber(derived.linesNet) &&
    isFiniteNumber(inv.subtotal) &&
    !close(derived.linesNet, inv.subtotal, tol)
  ) {
    findings.push({
      severity: "warning",
      code: "lines-vs-subtotal",
      field: "subtotal",
      message:
        `The line net amounts add up to ${money(derived.linesNet)}, but the ` +
        `subtotal is ${money(inv.subtotal)}.`,
    });
  }

  if (
    isFiniteNumber(derived.linesVat) &&
    isFiniteNumber(inv.tax_total) &&
    !close(derived.linesVat, inv.tax_total, tol)
  ) {
    findings.push({
      severity: "warning",
      code: "lines-vs-tax-total",
      field: "tax_total",
      message:
        `The line tax amounts add up to ${money(derived.linesVat)}, but the ` +
        `tax total is ${money(inv.tax_total)}.`,
    });
  }

  if (
    isFiniteNumber(derived.linesGross) &&
    isFiniteNumber(inv.total) &&
    !close(derived.linesGross, inv.total, tol)
  ) {
    findings.push({
      severity: "warning",
      code: "lines-vs-total",
      field: "total",
      message:
        `The line totals add up to ${money(derived.linesGross)}, but the ` +
        `invoice total is ${money(inv.total)}.`,
    });
  }

  return finish(findings, derived);
}

function finish(
  findings: Finding[],
  derived: ValidationResult["derived"],
): ValidationResult {
  const errors = findings.filter((f) => f.severity === "error");
  const warnings = findings.filter((f) => f.severity === "warning");
  const infos = findings.filter((f) => f.severity === "info");
  return {
    valid: errors.length === 0,
    findings,
    errors,
    warnings,
    infos,
    derived,
  };
}
