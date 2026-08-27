"use client";

import { useMemo, useRef, useState } from "react";

/* ----------------------------------------------------------------- types -- */

type RenderedPage = {
  pageNumber: number;
  width: number;
  height: number;
  src: string; // data URL
};

type InvoiceItem = {
  description: string | null;
  quantity: number | null;
  unit: string | null;
  unit_price: number | null;
  unit_price_includes_vat: boolean | null;
  tax_rate: number | null;
  line_net: number | null;
  line_vat: number | null;
  line_gross: number | null;
};

type InvoiceExtraction = {
  invoice_number: string | null;
  invoice_date: string | null;
  due_date: string | null;
  supplier_name: string | null;
  supplier_address: string | null;
  supplier_ico: string | null;
  supplier_dic: string | null;
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

type Usage = {
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  cost: number | null;
};

type Severity = "error" | "warning" | "info";

type Finding = {
  severity: Severity;
  code: string;
  field?: string;
  message: string;
};

type Validation = {
  valid: boolean;
  findings: Finding[];
  errors: Finding[];
  warnings: Finding[];
  infos: Finding[];
};

type QwenOutcome = {
  invoice: InvoiceExtraction;
  model: string;
  usage: Usage;
  finishReason: string | null;
  rawContent: string;
  qwenMs: number;
  totalMs: number;
  validation: Validation;
};

type RenderSummary = {
  pdfPages: number;
  pngPages: number;
  totalPngBytes: number;
  renderMs: number;
};

type StatusLine = { text: string; kind: "info" | "warn" | "error" | "ok" };

type StepState = "pending" | "active" | "ok" | "fail";
type Step = { key: string; label: string; state: StepState };

type ReviewStatus = "correct" | "incorrect";
type Review = { status: ReviewStatus; reasons: string[]; notes: string };

/** NDJSON events streamed by /api/process-invoice. */
type WireEvent =
  | { ev: "pdf-parsed"; pageCount: number; dpi: number }
  | { ev: "page-rendering"; pageNumber: number; pageCount: number }
  | {
      ev: "page-rendered";
      pageNumber: number;
      width: number;
      height: number;
      png: string;
    }
  | {
      ev: "render-done";
      pdfPages: number;
      pngPages: number;
      totalPngBytes: number;
      renderMs: number;
    }
  | {
      ev: "qwen-request";
      model: string;
      pageCount: number;
      rawMode: boolean;
    }
  | {
      ev: "qwen-done";
      invoice: InvoiceExtraction;
      model: string;
      usage: Usage;
      finishReason: string | null;
      rawContent: string;
      qwenMs: number;
      totalMs: number;
      validation: Validation;
    }
  | { ev: "error"; stage: "render" | "qwen"; kind: string; message: string };

/* ------------------------------------------------------------- constants -- */

const PIPELINE: { key: string; label: string }[] = [
  { key: "upload", label: "PDF uploaded" },
  { key: "render", label: "PDF rendered" },
  { key: "png", label: "PNG pages generated" },
  { key: "qwen-send", label: "Sending images to Qwen" },
  { key: "qwen-proc", label: "Qwen processing" },
  { key: "json", label: "JSON received" },
];

function freshSteps(): Step[] {
  return PIPELINE.map((s) => ({ ...s, state: "pending" as StepState }));
}

/** Manual review reasons — machine key + human label. Not AI-determined. */
const REVIEW_REASONS: [string, string][] = [
  ["invoice_number", "Invoice number"],
  ["invoice_date", "Invoice date"],
  ["due_date", "Due date"],
  ["supplier_information", "Supplier information"],
  ["customer_information", "Customer information"],
  ["ico", "IČO"],
  ["dic", "DIČ"],
  ["ic_dph", "IČ DPH"],
  ["currency", "Currency"],
  ["subtotal", "Subtotal"],
  ["vat_tax", "VAT / tax"],
  ["total", "Total"],
  ["iban", "IBAN"],
  ["payment_reference", "Payment reference"],
  ["missing_line_items", "Missing line items"],
  ["incorrect_line_items", "Incorrect line items"],
  ["missing_fields", "Missing fields"],
  ["other", "Other"],
];

const RENDER_ERROR_LABEL: Record<string, string> = {
  "bad-request": "Invalid request",
  "invalid-pdf": "Invalid PDF",
  "corrupt-pdf": "Corrupt PDF",
  "encrypted-pdf": "Encrypted / password-protected PDF",
  "pdf-parse-error": "PDF parsing error",
  "too-many-pages": "Too many pages",
  "page-render-error": "Page rendering error",
  unexpected: "Unexpected error",
};

const QWEN_ERROR_LABEL: Record<string, string> = {
  "missing-api-key": "Server misconfiguration — OPENROUTER_API_KEY is not set",
  auth: "OpenRouter authentication failed",
  "insufficient-credit": "Out of API credit",
  "api-error": "OpenRouter API error",
  network: "Network error",
  timeout: "Qwen request timed out",
  "invalid-response": "Unexpected OpenRouter response envelope",
  refusal: "Model refused the request",
  "empty-response": "Model returned no answer content",
  "invalid-json": "Model output was not valid JSON",
  "wrong-structure": "Model JSON had the wrong structure",
  "structured-output": "Structured output failed",
};

/* ----------------------------------------------------------------- style -- */

const panel: React.CSSProperties = {
  border: "1px solid #262626",
  borderRadius: 4,
  padding: 12,
  background: "#111",
};

const btn: React.CSSProperties = {
  background: "#1f1f1f",
  color: "#e5e5e5",
  border: "1px solid #333",
  borderRadius: 4,
  padding: "6px 14px",
  cursor: "pointer",
  font: "inherit",
};

const h2: React.CSSProperties = { fontSize: 13, color: "#888", margin: 0 };

/* -------------------------------------------------------------- helpers -- */

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function num(n: number | null): string {
  return n === null ? "—" : String(n);
}

const STEP_MARK: Record<StepState, string> = {
  pending: "·",
  active: "→",
  ok: "✓",
  fail: "✕",
};

const STEP_COLOR: Record<StepState, string> = {
  pending: "#555",
  active: "#e5e5e5",
  ok: "#4ade80",
  fail: "#f87171",
};

const SEVERITY_COLOR: Record<Severity, string> = {
  error: "#f87171",
  warning: "#fbbf24",
  info: "#9ca3af",
};

const SEVERITY_MARK: Record<Severity, string> = {
  error: "✕",
  warning: "!",
  info: "·",
};

/* =========================================================================== */

export default function Home() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);

  const [steps, setSteps] = useState<Step[]>(freshSteps());
  const [statuses, setStatuses] = useState<StatusLine[]>([]);
  const [pages, setPages] = useState<RenderedPage[]>([]);
  const [renderSummary, setRenderSummary] = useState<RenderSummary | null>(null);
  const [outcome, setOutcome] = useState<QwenOutcome | null>(null);

  const [review, setReview] = useState<Review | null>(null);
  /** Set from the qwen-request event: the run had no schema enforcement. */
  const [rawMode, setRawMode] = useState(false);

  function pushStatus(text: string, kind: StatusLine["kind"] = "info") {
    setStatuses((prev) => [...prev, { text, kind }]);
  }

  function setStep(key: string, state: StepState) {
    setSteps((prev) => prev.map((s) => (s.key === key ? { ...s, state } : s)));
  }

  /** Mark whichever step is currently active as failed. */
  function failActiveStep() {
    setSteps((prev) =>
      prev.map((s) => (s.state === "active" ? { ...s, state: "fail" } : s)),
    );
  }

  async function processPdf() {
    if (!file || busy) return;

    setBusy(true);
    setSteps(freshSteps());
    setStatuses([]);
    setPages([]);
    setRenderSummary(null);
    setOutcome(null);
    setReview(null);
    setRawMode(false);

    setStep("upload", "ok");
    setStep("render", "active");
    pushStatus("Uploading PDF");

    let res: Response;
    try {
      const body = new FormData();
      body.append("file", file);
      res = await fetch("/api/process-invoice", { method: "POST", body });
    } catch (err) {
      pushStatus(
        `Upload failed: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
      failActiveStep();
      setBusy(false);
      return;
    }

    // Pre-stream failure (bad request, payload too large): JSON error body.
    if (!res.ok && !res.headers.get("content-type")?.includes("ndjson")) {
      let message = `HTTP ${res.status}`;
      try {
        const j = await res.json();
        message = `${RENDER_ERROR_LABEL[j.kind] ?? j.kind ?? "Error"}: ${j.message}`;
      } catch {
        /* keep default */
      }
      pushStatus(message, "error");
      failActiveStep();
      setBusy(false);
      return;
    }

    if (!res.body) {
      pushStatus("No response stream from server.", "error");
      failActiveStep();
      setBusy(false);
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let nl: number;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          handleEvent(JSON.parse(line) as WireEvent);
        }
      }
    } catch (err) {
      pushStatus(
        `Stream error: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
      failActiveStep();
    }

    setBusy(false);
  }

  function handleEvent(event: WireEvent) {
    switch (event.ev) {
      case "pdf-parsed":
        pushStatus(`PDF parsed: ${event.pageCount} page(s) @ ${event.dpi} DPI`);
        break;

      case "page-rendering":
        pushStatus(`Rendering page ${event.pageNumber} / ${event.pageCount}`);
        break;

      case "page-rendered":
        setPages((prev) => [
          ...prev,
          {
            pageNumber: event.pageNumber,
            width: event.width,
            height: event.height,
            src: `data:image/png;base64,${event.png}`,
          },
        ]);
        break;

      case "render-done":
        setStep("render", "ok");
        setStep("png", "ok");
        setRenderSummary({
          pdfPages: event.pdfPages,
          pngPages: event.pngPages,
          totalPngBytes: event.totalPngBytes,
          renderMs: event.renderMs,
        });
        pushStatus(
          `PNG pages generated: ${event.pngPages} page(s) in ${event.renderMs} ms`,
          "ok",
        );
        break;

      case "qwen-request":
        setStep("qwen-send", "ok");
        setStep("qwen-proc", "active");
        pushStatus(
          `Sending ${event.pageCount} image(s) to Qwen (${event.model})`,
        );
        if (event.rawMode) {
          setRawMode(true);
          pushStatus(
            "QWEN_RAW=1 — no response_format / json_schema sent. The field " +
              "names below are the model's own invention and will not match " +
              "the app schema.",
            "warn",
          );
        }
        break;

      case "qwen-done": {
        setStep("qwen-proc", "ok");
        setStep("json", "ok");
        const o: QwenOutcome = {
          invoice: event.invoice,
          model: event.model,
          usage: event.usage,
          finishReason: event.finishReason ?? null,
          rawContent: event.rawContent,
          qwenMs: event.qwenMs,
          totalMs: event.totalMs,
          validation: event.validation,
        };
        setOutcome(o);
        pushStatus(
          `JSON received: ${o.invoice.items?.length ?? 0} line item(s), ` +
            `Qwen ${o.qwenMs} ms, total ${o.totalMs} ms`,
          "ok",
        );
        const v = o.validation;
        pushStatus(
          `Validation: ${v.valid ? "valid" : "INVALID"} — ` +
            `${v.errors.length} error(s), ${v.warnings.length} warning(s), ` +
            `${v.infos.length} note(s)`,
          v.errors.length > 0 ? "error" : v.warnings.length > 0 ? "warn" : "ok",
        );
        break;
      }

      case "error": {
        const label =
          event.stage === "qwen"
            ? (QWEN_ERROR_LABEL[event.kind] ?? event.kind ?? "Error")
            : (RENDER_ERROR_LABEL[event.kind] ?? event.kind ?? "Error");
        pushStatus(`Failed — ${label}: ${event.message}`, "error");
        failActiveStep();
        break;
      }

      default:
        break;
    }
  }

  /* --------------------------------------------------------- review flow -- */

  function markCorrect() {
    setReview({ status: "correct", reasons: [], notes: "" });
  }

  function markIncorrect() {
    setReview((prev) =>
      prev && prev.status === "incorrect"
        ? prev
        : { status: "incorrect", reasons: [], notes: "" },
    );
  }

  function toggleReason(key: string) {
    setReview((prev) => {
      if (!prev || prev.status !== "incorrect") return prev;
      const has = prev.reasons.includes(key);
      return {
        ...prev,
        reasons: has
          ? prev.reasons.filter((r) => r !== key)
          : [...prev.reasons, key],
      };
    });
  }

  function setNotes(notes: string) {
    setReview((prev) =>
      prev && prev.status === "incorrect" ? { ...prev, notes } : prev,
    );
  }

  const exportPayload = useMemo(() => {
    if (!outcome) return null;
    return {
      invoice: outcome.invoice,
      provider: "qwen",
      model: outcome.model,
      validation: {
        valid: outcome.validation.valid,
        errors: outcome.validation.errors.map((f) => f.message),
        warnings: outcome.validation.warnings.map((f) => f.message),
        notes: outcome.validation.infos.map((f) => f.message),
      },
      usage: outcome.usage,
      timing: {
        qwen_ms: outcome.qwenMs,
        total_ms: outcome.totalMs,
        render_ms: renderSummary?.renderMs ?? null,
      },
      human_review: review
        ? {
            status: review.status,
            reasons: review.reasons,
            notes: review.notes || null,
          }
        : null,
    };
  }, [outcome, review, renderSummary]);

  function downloadResult() {
    if (!exportPayload) return;
    const blob = new Blob([JSON.stringify(exportPayload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `invoice-result-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  /* ---------------------------------------------------------------- view -- */

  return (
    <main
      style={{
        maxWidth: 960,
        margin: "0 auto",
        padding: "32px 16px",
        display: "flex",
        flexDirection: "column",
        gap: 20,
      }}
    >
      <h1 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>
        Invoice Processing Lab — PDF → PNG → Qwen3.8 Max
      </h1>

      <div
        style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}
      >
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf"
          disabled={busy}
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          style={{ color: "#e5e5e5" }}
        />
        <button
          type="button"
          onClick={processPdf}
          disabled={busy || !file}
          style={{
            ...btn,
            color: busy || !file ? "#666" : "#e5e5e5",
            cursor: busy || !file ? "not-allowed" : "pointer",
          }}
        >
          {busy ? "Processing…" : "Process invoice"}
        </button>
      </div>

      {/* Pipeline checklist */}
      <section style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <h2 style={h2}>Pipeline</h2>
        <div style={{ ...panel, display: "flex", flexDirection: "column", gap: 2 }}>
          {steps.map((s) => (
            <div key={s.key} style={{ color: STEP_COLOR[s.state] }}>
              <span
                style={{ display: "inline-block", width: 18, textAlign: "center" }}
              >
                {STEP_MARK[s.state]}
              </span>
              {s.label}
            </div>
          ))}
        </div>
      </section>

      {/* Detailed status log */}
      <section style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <h2 style={h2}>Status log</h2>
        <div style={{ ...panel, minHeight: 90, whiteSpace: "pre-wrap" }}>
          {statuses.length === 0 ? (
            <span style={{ color: "#555" }}>idle</span>
          ) : (
            statuses.map((s, i) => (
              <div
                key={i}
                style={{
                  color:
                    s.kind === "error"
                      ? "#f87171"
                      : s.kind === "warn"
                        ? "#fbbf24"
                        : s.kind === "ok"
                          ? "#4ade80"
                          : "#e5e5e5",
                }}
              >
                {s.text}
              </div>
            ))
          )}
        </div>
      </section>

      {/* Render summary */}
      {(renderSummary || file) && (
        <section style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <h2 style={h2}>Render summary</h2>
          <div style={{ ...panel, display: "flex", gap: 24, flexWrap: "wrap" }}>
            {file && <span>File: {file.name}</span>}
            {file && <span>Size: {kb(file.size)}</span>}
            {renderSummary && <span>PDF pages: {renderSummary.pdfPages}</span>}
            {renderSummary && <span>PNG pages: {renderSummary.pngPages}</span>}
            {renderSummary && (
              <span>Total PNG: {kb(renderSummary.totalPngBytes)}</span>
            )}
            {renderSummary && (
              <span>Render time: {renderSummary.renderMs} ms</span>
            )}
          </div>
        </section>
      )}

      {/* PNG previews — exactly what was sent to Qwen */}
      <section style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <h2 style={h2}>
          PNG pages sent to Qwen {pages.length > 0 ? `(${pages.length})` : ""}
        </h2>
        {pages.length === 0 ? (
          <div style={{ ...panel, minHeight: 100, color: "#555" }}>empty</div>
        ) : (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
              gap: 12,
            }}
          >
            {pages.map((p) => (
              <figure key={p.pageNumber} style={{ ...panel, margin: 0 }}>
                <figcaption
                  style={{
                    fontSize: 12,
                    color: "#888",
                    marginBottom: 8,
                    display: "flex",
                    justifyContent: "space-between",
                  }}
                >
                  <span>page {p.pageNumber}</span>
                  <span>
                    {p.width} × {p.height}
                  </span>
                </figcaption>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={p.src}
                  alt={`Rendered page ${p.pageNumber}`}
                  style={{
                    width: "100%",
                    height: "auto",
                    display: "block",
                    background: "#fff",
                    border: "1px solid #333",
                  }}
                />
              </figure>
            ))}
          </div>
        )}
      </section>

      {/* Metrics */}
      {outcome && (
        <section style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <h2 style={h2}>Metrics</h2>
          <div style={{ ...panel, display: "flex", gap: 24, flexWrap: "wrap" }}>
            <span>Model: {outcome.model}</span>
            <span>Qwen request time: {outcome.qwenMs} ms</span>
            <span>Total processing time: {outcome.totalMs} ms</span>
            <span>Input tokens: {num(outcome.usage.prompt_tokens)}</span>
            <span>Output tokens: {num(outcome.usage.completion_tokens)}</span>
            <span>Total tokens: {num(outcome.usage.total_tokens)}</span>
            {outcome.usage.cost !== null && (
              <span>Cost: {outcome.usage.cost}</span>
            )}
            {outcome.finishReason && (
              <span>finish_reason: {outcome.finishReason}</span>
            )}
          </div>
        </section>
      )}

      {/* Deterministic validation */}
      {outcome && (
        <section style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <h2 style={h2}>Validation</h2>
          <div
            style={{ ...panel, display: "flex", flexDirection: "column", gap: 10 }}
          >
            <div
              style={{
                color: outcome.validation.valid ? "#4ade80" : "#f87171",
                fontWeight: 600,
              }}
            >
              {outcome.validation.valid ? "✓ VALID" : "✕ INVALID"}
              <span style={{ color: "#888", fontWeight: 400, marginLeft: 10 }}>
                {outcome.validation.errors.length} error(s),{" "}
                {outcome.validation.warnings.length} warning(s),{" "}
                {outcome.validation.infos.length} note(s)
              </span>
            </div>

            {outcome.validation.findings.length === 0 ? (
              <div style={{ color: "#888", fontSize: 12.5 }}>
                Every deterministic check passed. This says the numbers are
                self-consistent — it does not say they match the document.
              </div>
            ) : (
              <div
                style={{ display: "flex", flexDirection: "column", gap: 4 }}
              >
                {outcome.validation.findings.map((f, i) => (
                  <div
                    key={i}
                    style={{
                      color: SEVERITY_COLOR[f.severity],
                      fontSize: 12.5,
                      display: "flex",
                      gap: 8,
                    }}
                  >
                    <span style={{ flexShrink: 0 }}>
                      {SEVERITY_MARK[f.severity]}
                    </span>
                    <span>{f.message}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      )}

      {/* Extracted JSON */}
      {outcome && (
        <section style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <h2 style={h2}>Extracted JSON</h2>
          {rawMode && (
            <div
              style={{
                ...panel,
                borderColor: "#78350f",
                background: "#1c1408",
                color: "#fbbf24",
                fontSize: 12.5,
              }}
            >
              Probe mode (QWEN_RAW=1): this run sent no JSON schema. The shape
              below is unconstrained and can differ between invoices — do not
              evaluate it as schema output.
            </div>
          )}
          <pre
            style={{
              ...panel,
              margin: 0,
              overflowX: "auto",
              fontSize: 12.5,
              lineHeight: 1.55,
            }}
          >
            {JSON.stringify(outcome.invoice, null, 2)}
          </pre>
          <details style={{ ...panel }}>
            <summary style={{ cursor: "pointer", color: "#888" }}>
              Raw model response
            </summary>
            <pre
              style={{
                margin: "8px 0 0",
                overflowX: "auto",
                fontSize: 12.5,
                whiteSpace: "pre-wrap",
              }}
            >
              {outcome.rawContent}
            </pre>
          </details>
        </section>
      )}

      {/* Human review */}
      {outcome && (
        <section style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <h2 style={h2}>Human review</h2>
          <div
            style={{ ...panel, display: "flex", flexDirection: "column", gap: 12 }}
          >
            <p style={{ margin: 0, color: "#888", fontSize: 12.5 }}>
              Manual evaluation. Inspect the invoice against the extracted JSON
              above, then record your own verdict — this is not automatic
              validation.
            </p>

            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button
                type="button"
                onClick={markCorrect}
                style={{
                  ...btn,
                  borderColor:
                    review?.status === "correct" ? "#4ade80" : "#333",
                  color: review?.status === "correct" ? "#4ade80" : "#e5e5e5",
                }}
              >
                ✓ CORRECT
              </button>
              <button
                type="button"
                onClick={markIncorrect}
                style={{
                  ...btn,
                  borderColor:
                    review?.status === "incorrect" ? "#f87171" : "#333",
                  color: review?.status === "incorrect" ? "#f87171" : "#e5e5e5",
                }}
              >
                ✕ INCORRECT
              </button>
            </div>

            {review?.status === "correct" && (
              <div style={{ color: "#4ade80" }}>✓ Human review: CORRECT</div>
            )}

            {review?.status === "incorrect" && (
              <div
                style={{ display: "flex", flexDirection: "column", gap: 10 }}
              >
                <div style={{ color: "#f87171" }}>
                  ✕ Human review: INCORRECT
                </div>

                <div style={{ color: "#888", fontSize: 12.5 }}>
                  What was wrong? (select all that apply)
                </div>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns:
                      "repeat(auto-fill, minmax(200px, 1fr))",
                    gap: 4,
                  }}
                >
                  {REVIEW_REASONS.map(([key, label]) => (
                    <label
                      key={key}
                      style={{
                        display: "flex",
                        gap: 8,
                        alignItems: "center",
                        cursor: "pointer",
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={review.reasons.includes(key)}
                        onChange={() => toggleReason(key)}
                      />
                      {label}
                    </label>
                  ))}
                </div>

                <label
                  style={{ display: "flex", flexDirection: "column", gap: 4 }}
                >
                  <span style={{ color: "#888", fontSize: 12.5 }}>Notes</span>
                  <textarea
                    value={review.notes}
                    onChange={(e) => setNotes(e.target.value)}
                    rows={3}
                    placeholder="Briefly describe the problem"
                    style={{
                      background: "#0a0a0a",
                      color: "#e5e5e5",
                      border: "1px solid #333",
                      borderRadius: 4,
                      padding: 8,
                      font: "inherit",
                      resize: "vertical",
                    }}
                  />
                </label>

                {review.reasons.length > 0 && (
                  <div style={{ fontSize: 12.5, color: "#ccc" }}>
                    Selected reasons:{" "}
                    {review.reasons
                      .map(
                        (r) =>
                          REVIEW_REASONS.find(([k]) => k === r)?.[1] ?? r,
                      )
                      .join(", ")}
                  </div>
                )}
              </div>
            )}
          </div>
        </section>
      )}

      {/* Export */}
      {outcome && (
        <section style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <h2 style={h2}>Export</h2>
          <div
            style={{ ...panel, display: "flex", flexDirection: "column", gap: 10 }}
          >
            <button type="button" onClick={downloadResult} style={btn}>
              Download result JSON
            </button>
            <pre
              style={{
                margin: 0,
                overflowX: "auto",
                fontSize: 12,
                color: "#9ca3af",
                whiteSpace: "pre-wrap",
              }}
            >
              {JSON.stringify(exportPayload, null, 2)}
            </pre>
          </div>
        </section>
      )}
    </main>
  );
}
