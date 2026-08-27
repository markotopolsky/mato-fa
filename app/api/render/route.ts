import type { NextRequest } from "next/server";
import {
  clampDpi,
  PdfRenderError,
  renderPdfToPngPages,
  type RenderErrorKind,
} from "@/app/lib/pdf-render";

// MuPDF WASM + image encoding is CPU-bound and must run in the Node.js runtime.
export const runtime = "nodejs";
// Forward-looking: a large scanned PDF at high DPI can exceed short defaults on
// a serverless deploy. No-op locally.
export const maxDuration = 300;

const MAX_BYTES = 50 * 1024 * 1024; // 50 MB upload ceiling.

type PageMeta = {
  pageNumber: number;
  width: number;
  height: number;
  bytes: number; // raw PNG bytes (pre-base64)
};

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
      ev: "done";
      fileName: string;
      fileSize: number;
      dpi: number;
      pdfPages: number;
      pngPages: number;
      totalPngBytes: number;
      renderMs: number;
      pages: PageMeta[];
    }
  | {
      ev: "error";
      kind: RenderErrorKind | "bad-request";
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

  // Untrusted query param -> clamped into a safe DPI range.
  const dpi = clampDpi(new URL(request.url).searchParams.get("dpi"));
  const fileName = file.name || "upload.pdf";
  const fileSize = file.size;

  const data = new Uint8Array(await file.arrayBuffer());
  // The uploaded PDF lives only in this buffer; it is never written to disk.

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: WireEvent) => {
        controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      };

      const startedAt = performance.now();
      let pdfPages = 0;
      let totalPngBytes = 0;
      const pages: PageMeta[] = [];

      try {
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
            totalPngBytes += png.length;
            pages.push({ pageNumber, width, height, bytes: png.length });
            send({
              ev: "page-rendered",
              pageNumber,
              width,
              height,
              png: Buffer.from(png).toString("base64"),
            });
          }
        }

        send({
          ev: "done",
          fileName,
          fileSize,
          dpi,
          pdfPages,
          pngPages: pages.length,
          totalPngBytes,
          renderMs: Math.round(performance.now() - startedAt),
          pages,
        });
      } catch (err) {
        // Keep the root cause on the server; the client only needs the message.
        console.error("[api/render] render failed:", err);
        if (err instanceof PdfRenderError) {
          send({ ev: "error", kind: err.kind, page: err.page, message: err.message });
        } else {
          send({
            ev: "error",
            kind: "unexpected",
            message: `Unexpected rendering error: ${
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
