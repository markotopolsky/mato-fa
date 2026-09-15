"use client";

import { useMemo, useRef, useState } from "react";

/* ----------------------------------------------------------------- types -- */

type RenderedPage = {
  pageNumber: number;
  width: number;
  height: number;
  src: string; // data URL
};

type BlockType = "heading" | "paragraph" | "key_value" | "list" | "table" | "other";

type ContentBlock = {
  type: BlockType;
  text: string | null;
  key: string | null;
  value: string | null;
  items: string[] | null;
  rows: string[][] | null;
};

type DocumentExtraction = {
  language: string | null;
  document_type: string | null;
  pages: { page: number; blocks: ContentBlock[] }[];
};

type Usage = {
  input_tokens: number;
  output_tokens: number;
  cost_usd: number | null;
};

type ClaudeOutcome = {
  document: DocumentExtraction;
  model: string;
  usage: Usage;
  stopReason: string | null;
  rawContent: string;
  claudeMs: number;
  totalMs: number;
};

type RenderSummary = {
  pageCount: number;
  totalImageBytes: number;
  renderMs: number;
};

type StatusLine = { text: string; kind: "info" | "warn" | "error" | "ok" };

type StepState = "pending" | "active" | "ok" | "fail";
type Step = { key: string; label: string; state: StepState };

/** NDJSON events streamed by /api/process-document. */
type WireEvent =
  | { ev: "document-parsed"; pageCount: number; dpi: number }
  | { ev: "page-rendering"; pageNumber: number; pageCount: number }
  | {
      ev: "page-rendered";
      pageNumber: number;
      width: number;
      height: number;
      jpeg: string;
    }
  | {
      ev: "render-done";
      pageCount: number;
      totalImageBytes: number;
      renderMs: number;
    }
  | { ev: "claude-request"; model: string; pageCount: number }
  | { ev: "claude-progress"; chars: number }
  | ({ ev: "claude-done" } & ClaudeOutcome)
  | { ev: "error"; stage: "render" | "claude"; kind: string; message: string };

/* ------------------------------------------------------------- constants -- */

/**
 * File types MuPDF opens in this build. Verified: PDF, DOCX, XLSX, HTML, TXT,
 * PNG, JPEG. ODT, RTF and SVG are not supported and are left out.
 */
const ACCEPT = [
  ".pdf", ".docx", ".xlsx", ".pptx", ".xps", ".oxps", ".epub", ".mobi", ".fb2",
  ".cbz", ".html", ".htm", ".xhtml", ".txt", ".png", ".jpg", ".jpeg", ".tif",
  ".tiff", ".bmp", ".gif", ".jxr", ".psd",
].join(",");

const PIPELINE: { key: string; label: string }[] = [
  { key: "upload", label: "Document uploaded" },
  { key: "render", label: "Pages rendered" },
  { key: "claude-send", label: "Sending pages to Claude" },
  { key: "claude-proc", label: "Claude transcribing" },
  { key: "json", label: "Content received" },
];

function freshSteps(): Step[] {
  return PIPELINE.map((s) => ({ ...s, state: "pending" as StepState }));
}

const RENDER_ERROR_LABEL: Record<string, string> = {
  "bad-request": "Invalid request",
  "unsupported-format": "Unsupported file type",
  "corrupt-document": "Corrupt document",
  "encrypted-document": "Encrypted / password-protected document",
  "parse-error": "Document parsing error",
  "too-many-pages": "Too many pages",
  "page-render-error": "Page rendering error",
  unexpected: "Unexpected error",
};

const CLAUDE_ERROR_LABEL: Record<string, string> = {
  "missing-api-key": "Server misconfiguration — OPENROUTER_API_KEY is not set",
  auth: "OpenRouter authentication failed",
  "insufficient-credit": "Not enough OpenRouter credit",
  "rate-limit": "Rate limited",
  "request-too-large": "Request too large",
  "api-error": "OpenRouter API error",
  network: "Network error",
  timeout: "Claude request timed out",
  refusal: "Model declined the document",
  truncated: "Document too long for one request",
  "empty-response": "Model returned no content",
  "invalid-json": "Model output was not valid JSON",
  "wrong-structure": "Model JSON had the wrong structure",
  unexpected: "Unexpected error",
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

const section: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

const cell: React.CSSProperties = {
  border: "1px solid #333",
  padding: "4px 8px",
  textAlign: "left",
  verticalAlign: "top",
  whiteSpace: "pre-wrap",
};

/* -------------------------------------------------------------- helpers -- */

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
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

function jsonFileName(file: File | null): string {
  const base = file?.name.replace(/\.[^.]+$/, "") || "document";
  return `${base}.json`;
}

/* ------------------------------------------------------ content renderer -- */

function Block({ block }: { block: ContentBlock }) {
  switch (block.type) {
    case "heading":
      return (
        <div style={{ fontWeight: 600, fontSize: 15, whiteSpace: "pre-wrap" }}>
          {block.text}
        </div>
      );
    case "paragraph":
      return <div style={{ whiteSpace: "pre-wrap" }}>{block.text}</div>;
    case "key_value":
      return (
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <span style={{ color: "#888", minWidth: 160 }}>{block.key}</span>
          <span style={{ whiteSpace: "pre-wrap" }}>{block.value}</span>
        </div>
      );
    case "list":
      return (
        <ul style={{ margin: 0, paddingLeft: 20 }}>
          {(block.items ?? []).map((item, i) => (
            <li key={i} style={{ whiteSpace: "pre-wrap" }}>
              {item}
            </li>
          ))}
        </ul>
      );
    case "table": {
      const [head, ...body] = block.rows ?? [];
      if (!head) return null;
      return (
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", fontSize: 12.5 }}>
            <thead>
              <tr>
                {head.map((c, i) => (
                  <th key={i} style={{ ...cell, color: "#aaa", fontWeight: 600 }}>
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {body.map((row, r) => (
                <tr key={r}>
                  {row.map((c, i) => (
                    <td key={i} style={cell}>
                      {c}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    default:
      return (
        <div style={{ color: "#9ca3af", fontStyle: "italic", whiteSpace: "pre-wrap" }}>
          {block.text}
        </div>
      );
  }
}

/* =========================================================================== */

export default function Home() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);

  const [steps, setSteps] = useState<Step[]>(freshSteps());
  const [statuses, setStatuses] = useState<StatusLine[]>([]);
  const [pages, setPages] = useState<RenderedPage[]>([]);
  const [renderSummary, setRenderSummary] = useState<RenderSummary | null>(null);
  const [progressChars, setProgressChars] = useState<number | null>(null);
  const [outcome, setOutcome] = useState<ClaudeOutcome | null>(null);
  const [view, setView] = useState<"content" | "json">("content");

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

  async function processDocument() {
    if (!file || busy) return;

    setBusy(true);
    setSteps(freshSteps());
    setStatuses([]);
    setPages([]);
    setRenderSummary(null);
    setProgressChars(null);
    setOutcome(null);

    setStep("upload", "ok");
    setStep("render", "active");
    pushStatus("Uploading document");

    let res: Response;
    try {
      const body = new FormData();
      body.append("file", file);
      res = await fetch("/api/process-document", { method: "POST", body });
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
      case "document-parsed":
        pushStatus(`Document parsed: ${event.pageCount} page(s) @ ${event.dpi} DPI`);
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
            src: `data:image/jpeg;base64,${event.jpeg}`,
          },
        ]);
        break;

      case "render-done":
        setStep("render", "ok");
        setRenderSummary({
          pageCount: event.pageCount,
          totalImageBytes: event.totalImageBytes,
          renderMs: event.renderMs,
        });
        pushStatus(
          `Pages rendered: ${event.pageCount} page(s) in ${event.renderMs} ms`,
          "ok",
        );
        break;

      case "claude-request":
        setStep("claude-send", "ok");
        setStep("claude-proc", "active");
        pushStatus(`Sending ${event.pageCount} page(s) to Claude (${event.model})`);
        break;

      case "claude-progress":
        setProgressChars(event.chars);
        break;

      case "claude-done": {
        setStep("claude-proc", "ok");
        setStep("json", "ok");
        const o: ClaudeOutcome = {
          document: event.document,
          model: event.model,
          usage: event.usage,
          stopReason: event.stopReason,
          rawContent: event.rawContent,
          claudeMs: event.claudeMs,
          totalMs: event.totalMs,
        };
        setOutcome(o);
        const blocks = o.document.pages.reduce((n, p) => n + p.blocks.length, 0);
        pushStatus(
          `Content received: ${o.document.pages.length} page(s), ${blocks} block(s), ` +
            `Claude ${(o.claudeMs / 1000).toFixed(1)} s, total ${(o.totalMs / 1000).toFixed(1)} s`,
          "ok",
        );
        break;
      }

      case "error": {
        const label =
          event.stage === "claude"
            ? (CLAUDE_ERROR_LABEL[event.kind] ?? event.kind ?? "Error")
            : (RENDER_ERROR_LABEL[event.kind] ?? event.kind ?? "Error");
        pushStatus(`Failed — ${label}: ${event.message}`, "error");
        failActiveStep();
        break;
      }

      default:
        break;
    }
  }

  const exportJson = useMemo(
    () => (outcome ? JSON.stringify(outcome.document, null, 2) : ""),
    [outcome],
  );

  function downloadResult() {
    if (!outcome) return;
    const blob = new Blob([exportJson], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = jsonFileName(file);
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
        Document Reader — any document → Claude Fable → structured JSON
      </h1>

      <div
        style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}
      >
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          disabled={busy}
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          style={{ color: "#e5e5e5" }}
        />
        <button
          type="button"
          onClick={processDocument}
          disabled={busy || !file}
          style={{
            ...btn,
            color: busy || !file ? "#666" : "#e5e5e5",
            cursor: busy || !file ? "not-allowed" : "pointer",
          }}
        >
          {busy ? "Processing…" : "Read document"}
        </button>
      </div>

      {/* Pipeline checklist */}
      <section style={section}>
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
              {s.key === "claude-proc" && s.state === "active" && progressChars !== null && (
                <span style={{ color: "#888" }}> — {progressChars.toLocaleString()} chars</span>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* Detailed status log */}
      <section style={section}>
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
        <section style={section}>
          <h2 style={h2}>Render summary</h2>
          <div style={{ ...panel, display: "flex", gap: 24, flexWrap: "wrap" }}>
            {file && <span>File: {file.name}</span>}
            {file && <span>Size: {kb(file.size)}</span>}
            {renderSummary && <span>Pages: {renderSummary.pageCount}</span>}
            {renderSummary && (
              <span>Total images: {kb(renderSummary.totalImageBytes)}</span>
            )}
            {renderSummary && <span>Render time: {renderSummary.renderMs} ms</span>}
          </div>
        </section>
      )}

      {/* Page previews — exactly what was sent to Claude */}
      <section style={section}>
        <h2 style={h2}>
          Pages sent to Claude {pages.length > 0 ? `(${pages.length})` : ""}
        </h2>
        {pages.length === 0 ? (
          <div style={{ ...panel, minHeight: 100, color: "#555" }}>empty</div>
        ) : (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
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
        <section style={section}>
          <h2 style={h2}>Metrics</h2>
          <div style={{ ...panel, display: "flex", gap: 24, flexWrap: "wrap" }}>
            <span>Model: {outcome.model}</span>
            <span>Claude time: {(outcome.claudeMs / 1000).toFixed(1)} s</span>
            <span>Total time: {(outcome.totalMs / 1000).toFixed(1)} s</span>
            <span>Input tokens: {outcome.usage.input_tokens.toLocaleString()}</span>
            <span>Output tokens: {outcome.usage.output_tokens.toLocaleString()}</span>
            <span>
              Estimated cost:{" "}
              {outcome.usage.cost_usd === null
                ? "—"
                : `$${outcome.usage.cost_usd.toFixed(4)}`}
            </span>
          </div>
        </section>
      )}

      {/* Extracted content */}
      {outcome && (
        <section style={section}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <h2 style={{ ...h2, marginRight: "auto" }}>
              Document content
              {outcome.document.document_type && ` — ${outcome.document.document_type}`}
              {outcome.document.language && ` (${outcome.document.language})`}
            </h2>
            {(["content", "json"] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setView(v)}
                style={{
                  ...btn,
                  padding: "3px 10px",
                  borderColor: view === v ? "#e5e5e5" : "#333",
                }}
              >
                {v === "content" ? "Content" : "JSON"}
              </button>
            ))}
            <button type="button" onClick={downloadResult} style={{ ...btn, padding: "3px 10px" }}>
              Download {jsonFileName(file)}
            </button>
          </div>

          {view === "content" ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {outcome.document.pages.map((p) => (
                <article
                  key={p.page}
                  style={{ ...panel, display: "flex", flexDirection: "column", gap: 10 }}
                >
                  <div style={{ fontSize: 12, color: "#666" }}>page {p.page}</div>
                  {p.blocks.map((b, i) => (
                    <Block key={i} block={b} />
                  ))}
                </article>
              ))}
            </div>
          ) : (
            <pre
              style={{
                ...panel,
                margin: 0,
                overflowX: "auto",
                fontSize: 12.5,
                lineHeight: 1.55,
              }}
            >
              {exportJson}
            </pre>
          )}
        </section>
      )}
    </main>
  );
}
