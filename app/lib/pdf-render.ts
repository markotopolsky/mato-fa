import * as mupdf from "mupdf";

/**
 * PDF -> PNG rendering, powered by MuPDF (WASM build, runs in the Node.js
 * runtime with no native dependencies).
 *
 * The renderer is deliberately strict:
 *   - it never silently skips a page;
 *   - every failure surfaces as a `PdfRenderError` with a machine-readable
 *     `kind` so the UI can show a clear message.
 */

export const DEFAULT_DPI = 200;
/**
 * DPI bounds. Lower bound keeps text legible; upper bound caps the pixmap so a
 * pathological `?dpi=` value cannot make MuPDF allocate hundreds of MB (or trip
 * its own "Overly large image" guard on a request that otherwise looks valid).
 * 300 is the practical ceiling for document vision — see the audit notes.
 */
export const MIN_DPI = 72;
export const MAX_DPI = 300;
/**
 * Page ceiling for this prototype. Real invoices are a handful of pages; a
 * multi-hundred-page document would hold the response stream open for minutes
 * and make the browser accumulate that many data URLs.
 */
export const MAX_PAGES = 200;

/** Clamp an untrusted DPI value into [MIN_DPI, MAX_DPI]; junk -> DEFAULT_DPI. */
export function clampDpi(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_DPI;
  return Math.min(MAX_DPI, Math.max(MIN_DPI, Math.round(n)));
}

export type RenderErrorKind =
  | "invalid-pdf" // not a PDF at all
  | "corrupt-pdf" // looks like a PDF but MuPDF cannot open it
  | "encrypted-pdf" // password protected / encrypted
  | "pdf-parse-error" // opened, but structure could not be read (e.g. page count)
  | "too-many-pages" // opened fine, but exceeds MAX_PAGES
  | "page-render-error" // a specific page failed to render
  | "unexpected"; // anything else

export class PdfRenderError extends Error {
  readonly kind: RenderErrorKind;
  /** 1-based page number, when the error is tied to a specific page. */
  readonly page?: number;

  constructor(
    kind: RenderErrorKind,
    message: string,
    options: { cause?: unknown; page?: number } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "PdfRenderError";
    this.kind = kind;
    this.page = options.page;
  }
}

export type RenderedPage = {
  /** 1-based, in document order. */
  pageNumber: number;
  /** Pixel width of the rendered PNG. */
  width: number;
  /** Pixel height of the rendered PNG. */
  height: number;
  /** PNG image bytes. */
  png: Uint8Array;
};

export type RenderEvent =
  | { type: "pdf-parsed"; pageCount: number }
  | { type: "page-rendering"; pageNumber: number; pageCount: number }
  | { type: "page-rendered"; page: RenderedPage };

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Cheap header sniff so a non-PDF upload gets a precise error. */
function looksLikePdf(data: Uint8Array): boolean {
  // "%PDF-" may be preceded by a few junk bytes in the wild; scan the first 1KB.
  const limit = Math.min(data.length, 1024);
  for (let i = 0; i + 4 < limit; i++) {
    if (
      data[i] === 0x25 && // %
      data[i + 1] === 0x50 && // P
      data[i + 2] === 0x44 && // D
      data[i + 3] === 0x46 && // F
      data[i + 4] === 0x2d // -
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Render every page of a PDF to a PNG buffer, in order, at ~`dpi` resolution.
 *
 * Yields progress events as it goes so a caller can stream status to the client.
 * Throws `PdfRenderError` on any failure — a partial result is never returned.
 */
export async function* renderPdfToPngPages(
  data: Uint8Array,
  opts: { dpi?: number } = {},
): AsyncGenerator<RenderEvent, void, void> {
  const dpi = opts.dpi ?? DEFAULT_DPI;
  const zoom = dpi / 72; // MuPDF's base user space is 72 DPI.

  if (data.length === 0) {
    throw new PdfRenderError("invalid-pdf", "Uploaded file is empty.");
  }
  if (!looksLikePdf(data)) {
    throw new PdfRenderError(
      "invalid-pdf",
      "File does not look like a PDF (no %PDF- header found).",
    );
  }

  let doc: mupdf.Document;
  try {
    doc = mupdf.Document.openDocument(data, "application/pdf");
  } catch (err) {
    throw new PdfRenderError(
      "corrupt-pdf",
      `MuPDF could not open the PDF: ${errMessage(err)}`,
      { cause: err },
    );
  }

  try {
    let encrypted = false;
    try {
      encrypted = doc.needsPassword();
    } catch (err) {
      throw new PdfRenderError(
        "pdf-parse-error",
        `Could not determine encryption status: ${errMessage(err)}`,
        { cause: err },
      );
    }
    if (encrypted) {
      throw new PdfRenderError(
        "encrypted-pdf",
        "PDF is encrypted / password protected. Remove the password and retry.",
      );
    }

    let pageCount: number;
    try {
      pageCount = doc.countPages();
    } catch (err) {
      throw new PdfRenderError(
        "pdf-parse-error",
        `Could not read the page count: ${errMessage(err)}`,
        { cause: err },
      );
    }
    if (!Number.isInteger(pageCount) || pageCount < 1) {
      throw new PdfRenderError(
        "pdf-parse-error",
        `PDF reports an invalid page count (${pageCount}).`,
      );
    }
    if (pageCount > MAX_PAGES) {
      throw new PdfRenderError(
        "too-many-pages",
        `PDF has ${pageCount} pages; this prototype renders at most ${MAX_PAGES}.`,
      );
    }

    yield { type: "pdf-parsed", pageCount };

    for (let i = 0; i < pageCount; i++) {
      const pageNumber = i + 1;
      yield { type: "page-rendering", pageNumber, pageCount };

      let page: mupdf.Page | mupdf.PDFPage | undefined;
      let pixmap: mupdf.Pixmap | undefined;
      let png: Uint8Array;
      let width: number;
      let height: number;
      try {
        page = doc.loadPage(i);
        pixmap = page.toPixmap(
          mupdf.Matrix.scale(zoom, zoom),
          mupdf.ColorSpace.DeviceRGB,
          false, // no alpha -> white background, smaller PNG
        );
        width = pixmap.getWidth();
        height = pixmap.getHeight();
        png = pixmap.asPNG();
      } catch (err) {
        throw new PdfRenderError(
          "page-render-error",
          `Failed to render page ${pageNumber} of ${pageCount}: ${errMessage(err)}`,
          { cause: err, page: pageNumber },
        );
      } finally {
        pixmap?.destroy();
        page?.destroy();
      }

      if (!png || png.length === 0) {
        throw new PdfRenderError(
          "page-render-error",
          `Page ${pageNumber} of ${pageCount} produced an empty PNG.`,
          { page: pageNumber },
        );
      }

      yield {
        type: "page-rendered",
        page: { pageNumber, width, height, png },
      };
    }
  } finally {
    doc.destroy();
  }
}
