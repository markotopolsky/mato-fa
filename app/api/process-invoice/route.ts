import type { NextRequest } from "next/server";
import {
  clampDpi,
  PdfRenderError,
  renderPdfToPngPages,
  type RenderErrorKind,
} from "@/app/lib/pdf-render";
import {
  extractInvoice,
  QwenError,
  QWEN_MODEL,
  RAW_MODE,
  type InvoiceExtraction,
  type QwenErrorKind,
  type QwenPageImage,
  type QwenUsage,
} from "@/app/lib/qwen";
import { validateInvoice, type ValidationResult } from "@/app/lib/validate";

// MuPDF WASM + the Qwen request are both CPU / latency heavy; Node.js runtime.
export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_BYTES = 50 * 1024 * 1024; // 50 MB upload ceiling (unchanged from Phase 1).

type PageMeta = { pageNumber: number; width: number; height: number; bytes: number };

type WireEvent =
  | { ev: "pdf-parsed"; pageCount: number; dpi: number }
  | { ev: "page-rendering"; pageNumber: number; pageCount: number }
  | {
      ev: "page-rendered";
      pageNumber: number;
      width: number;
      height: number;
      png: string; // base64
    }
  | {
      ev: "render-done";
      pdfPages: number;
      pngPages: number;
      totalPngBytes: number;
      renderMs: number;
      pages: PageMeta[];
    }
  | {
      ev: "qwen-request";
      model: string;
      pageCount: number;
      /**
       * True when QWEN_RAW=1 stripped `response_format` / `json_schema` from the
       * request. The extracted JSON is then whatever shape the model chose, so
       * the client must say so instead of presenting it as schema-conforming.
       */
      rawMode: boolean;
    }
  | {
      ev: "qwen-done";
      invoice: InvoiceExtraction;
      model: string;
      usage: QwenUsage;
      finishReason: string | null;
      rawContent: string;
      qwenMs: number;
      totalMs: number;
      /** Deterministic checks over the extraction; never alters it. */
      validation: ValidationResult;
    }
  | {
      ev: "error";
      stage: "render" | "qwen";
      kind: RenderErrorKind | QwenErrorKind | "unexpected";
      page?: number;
      message: string;
    };

function jsonError(status: number, kind: string, message: string): Response {
  return new Response(JSON.stringify({ ev: "error", kind, message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export async function POST(request: NextRequest): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch (err) {
    return jsonError(
      400,
      "bad-request",
      `Expected multipart/form-data: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return jsonError(400, "bad-request", "Missing 'file' field in form data.");
  }
  if (file.size === 0) {
    return jsonError(400, "bad-request", "Uploaded file is empty.");
  }
  if (file.size > MAX_BYTES) {
    return jsonError(
      413,
      "bad-request",
      `File is ${file.size} bytes; limit is ${MAX_BYTES} bytes.`,
    );
  }

  const dpi = clampDpi(new URL(request.url).searchParams.get("dpi"));
  const data = new Uint8Array(await file.arrayBuffer());
  // The uploaded PDF lives only in this buffer; it is never written to disk.

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: WireEvent) => {
        controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      };

      const startedAt = performance.now();

      // ---- Stage 1: PDF -> PNG (reuses the Phase 1 renderer verbatim) --------
      const images: QwenPageImage[] = [];
      const pageMetas: PageMeta[] = [];
      let pdfPages = 0;
      let totalPngBytes = 0;

      try {
        const renderStart = performance.now();
        for await (const event of renderPdfToPngPages(data, { dpi })) {
          if (event.type === "pdf-parsed") {
            pdfPages = event.pageCount;
            send({ ev: "pdf-parsed", pageCount: event.pageCount, dpi });
          } else if (event.type === "page-rendering") {
            send({
              ev: "page-rendering",
              pageNumber: event.pageNumber,
              pageCount: event.pageCount,
            });
          } else {
            const { pageNumber, width, height, png } = event.page;
            const b64 = Buffer.from(png).toString("base64");
            totalPngBytes += png.length;
            pageMetas.push({ pageNumber, width, height, bytes: png.length });
            images.push({
              pageNumber,
              dataUrl: `data:image/png;base64,${b64}`,
            });
            send({ ev: "page-rendered", pageNumber, width, height, png: b64 });
          }
        }

        send({
          ev: "render-done",
          pdfPages,
          pngPages: images.length,
          totalPngBytes,
          renderMs: Math.round(performance.now() - renderStart),
          pages: pageMetas,
        });
      } catch (err) {
        console.error("[api/process-invoice] render failed:", err);
        if (err instanceof PdfRenderError) {
          send({
            ev: "error",
            stage: "render",
            kind: err.kind,
            page: err.page,
            message: err.message,
          });
        } else {
          send({
            ev: "error",
            stage: "render",
            kind: "unexpected",
            message: `Unexpected rendering error: ${
              err instanceof Error ? err.message : String(err)
            }`,
          });
        }
        controller.close();
        return;
      }

      // ---- Stage 2: PNG pages -> Qwen3.8 Max -> structured JSON --------------
      send({
        ev: "qwen-request",
        model: QWEN_MODEL,
        pageCount: images.length,
        rawMode: RAW_MODE,
      });

      try {
        const result = await extractInvoice(images);
        send({
          ev: "qwen-done",
          invoice: result.invoice,
          model: result.model,
          usage: result.usage,
          finishReason: result.finishReason,
          rawContent: result.rawContent,
          qwenMs: result.qwenMs,
          totalMs: Math.round(performance.now() - startedAt),
          // Runs on the extraction as returned; `result.invoice` is untouched.
          validation: validateInvoice(result.invoice),
        });
      } catch (err) {
        // QwenError messages never carry the API key; safe to log the object.
        console.error("[api/process-invoice] qwen failed:", err);
        if (err instanceof QwenError) {
          send({
            ev: "error",
            stage: "qwen",
            kind: err.kind,
            message: err.message,
          });
        } else {
          send({
            ev: "error",
            stage: "qwen",
            kind: "unexpected",
            message: `Unexpected Qwen error: ${
              err instanceof Error ? err.message : String(err)
            }`,
          });
        }
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    },
  });
}
