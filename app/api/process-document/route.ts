import type { NextRequest } from "next/server";
import { AUTH_COOKIE, isValidSession } from "@/app/lib/auth";
import {
  clampDpi,
  DocumentRenderError,
  renderDocumentToImages,
  type RenderErrorKind,
} from "@/app/lib/document-render";
import {
  CLAUDE_MODEL,
  ClaudeError,
  extractDocument,
  type ClaudeErrorKind,
  type ClaudeUsage,
  type DocumentExtraction,
  type PageImage,
} from "@/app/lib/claude";

// MuPDF WASM + a multi-minute Claude request; Node.js runtime.
export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_BYTES = 50 * 1024 * 1024; // 50 MB upload ceiling.

/** Minimum gap between progress events while Claude is generating. */
const PROGRESS_INTERVAL_MS = 1000;

type PageMeta = { pageNumber: number; width: number; height: number; bytes: number };

type WireEvent =
  | { ev: "document-parsed"; pageCount: number; dpi: number }
  | { ev: "page-rendering"; pageNumber: number; pageCount: number }
  | {
      ev: "page-rendered";
      pageNumber: number;
      width: number;
      height: number;
      jpeg: string; // base64
    }
  | {
      ev: "render-done";
      pageCount: number;
      totalImageBytes: number;
      renderMs: number;
      pages: PageMeta[];
    }
  | { ev: "claude-request"; model: string; pageCount: number }
  | { ev: "claude-progress"; chars: number }
  | {
      ev: "claude-done";
      document: DocumentExtraction;
      model: string;
      usage: ClaudeUsage;
      stopReason: string | null;
      rawContent: string;
      claudeMs: number;
      totalMs: number;
    }
  | {
      ev: "error";
      stage: "render" | "claude";
      kind: RenderErrorKind | ClaudeErrorKind | "unexpected";
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
  // proxy.ts already gates this route; re-checked here because every call is billed.
  if (!isValidSession(request.cookies.get(AUTH_COOKIE)?.value)) {
    return jsonError(401, "unauthorized", "Not logged in.");
  }

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
  // The uploaded document lives only in this buffer; it is never written to disk.

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: WireEvent) => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
        } catch {
          // The client disconnected and the stream is closed; nothing to tell.
        }
      };

      const startedAt = performance.now();

      // ---- Stage 1: document -> JPEG pages --------------------------------
      const images: PageImage[] = [];
      const pageMetas: PageMeta[] = [];
      let totalImageBytes = 0;

      try {
        const renderStart = performance.now();
        for await (const event of renderDocumentToImages(data, {
          fileName: file.name,
          mimeType: file.type,
          dpi,
        })) {
          if (event.type === "document-parsed") {
            send({ ev: "document-parsed", pageCount: event.pageCount, dpi });
          } else if (event.type === "page-rendering") {
            send({
              ev: "page-rendering",
              pageNumber: event.pageNumber,
              pageCount: event.pageCount,
            });
          } else {
            const { pageNumber, width, height, jpeg } = event.page;
            const b64 = Buffer.from(jpeg).toString("base64");
            totalImageBytes += jpeg.length;
            pageMetas.push({ pageNumber, width, height, bytes: jpeg.length });
            images.push({ pageNumber, base64: b64 });
            send({ ev: "page-rendered", pageNumber, width, height, jpeg: b64 });
          }
        }

        send({
          ev: "render-done",
          pageCount: images.length,
          totalImageBytes,
          renderMs: Math.round(performance.now() - renderStart),
          pages: pageMetas,
        });
      } catch (err) {
        console.error("[api/process-document] render failed:", err);
        if (err instanceof DocumentRenderError) {
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

      // ---- Stage 2: pages -> Claude -> structured JSON ---------------------
      send({ ev: "claude-request", model: CLAUDE_MODEL, pageCount: images.length });

      let lastProgressAt = 0;
      try {
        const result = await extractDocument(images, {
          // Client disconnect cancels the (billed) generation.
          signal: request.signal,
          onProgress: (chars) => {
            const now = performance.now();
            if (now - lastProgressAt < PROGRESS_INTERVAL_MS) return;
            lastProgressAt = now;
            send({ ev: "claude-progress", chars });
          },
        });
        send({
          ev: "claude-done",
          document: result.document,
          model: result.model,
          usage: result.usage,
          stopReason: result.stopReason,
          rawContent: result.rawContent,
          claudeMs: result.claudeMs,
          totalMs: Math.round(performance.now() - startedAt),
        });
      } catch (err) {
        // ClaudeError messages never carry the API key; safe to log the object.
        console.error("[api/process-document] claude failed:", err);
        if (err instanceof ClaudeError) {
          send({ ev: "error", stage: "claude", kind: err.kind, message: err.message });
        } else {
          send({
            ev: "error",
            stage: "claude",
            kind: "unexpected",
            message: `Unexpected Claude error: ${
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
