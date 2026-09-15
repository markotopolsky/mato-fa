import * as mupdf from "mupdf";

/**
 * Document -> JPEG page rendering, powered by MuPDF (WASM build, runs in the
 * Node.js runtime with no native dependencies).
 *
 * MuPDF opens far more than PDF: Office documents (DOCX, XLSX, PPTX, ODT, ODS,
 * ODP), EPUB / MOBI / FB2, XPS, CBZ, and raster images (PNG, JPEG, TIFF, BMP,
 * GIF, ...). Every format goes through the same path: open, lay out, render
 * each page to an image. The model then reads the pages visually, so a scan and
 * a born-digital file are handled identically.
 *
 * The renderer is deliberately strict:
 *   - it never silently skips a page;
 *   - every failure surfaces as a `DocumentRenderError` with a machine-readable
 *     `kind` so the UI can show a clear message.
 */

export const DEFAULT_DPI = 200;
/**
 * DPI bounds. Lower bound keeps text legible; upper bound caps the pixmap so a
 * pathological `?dpi=` value cannot make MuPDF allocate hundreds of MB.
 */
export const MIN_DPI = 72;
export const MAX_DPI = 300;
/**
 * Longest image edge the model reads at full resolution. Larger images are
 * downscaled by the API anyway, so rendering past this only adds upload bytes.
 */
export const MAX_LONG_EDGE_PX = 2576;
/**
 * Page ceiling. The Messages API accepts at most 100 images per request, and
 * every page becomes one image.
 */
export const MAX_PAGES = 100;
/**
 * JPEG, not PNG: a colour scan at 200 DPI is ~2.5 MB as PNG and ~0.4 MB as
 * JPEG, and the whole request must stay under the API's 32 MB limit. Quality 90
 * keeps small print and diacritics crisp.
 */
const JPEG_QUALITY = 90;

/**
 * Page size used to lay out reflowable formats (DOCX, EPUB, HTML, ...), which
 * have no fixed pages of their own. A4 in points, 11 pt base font. Fixed-layout
 * formats (PDF, XPS, images) ignore it.
 */
const LAYOUT_WIDTH_PT = 595;
const LAYOUT_HEIGHT_PT = 842;
const LAYOUT_EM_PT = 11;

/** Clamp an untrusted DPI value into [MIN_DPI, MAX_DPI]; junk -> DEFAULT_DPI. */
export function clampDpi(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_DPI;
  return Math.min(MAX_DPI, Math.max(MIN_DPI, Math.round(n)));
}

export type RenderErrorKind =
  | "unsupported-format" // MuPDF has no handler for this file type
  | "corrupt-document" // recognised type, but MuPDF cannot open it
  | "encrypted-document" // password protected / encrypted
  | "parse-error" // opened, but structure could not be read (e.g. page count)
  | "too-many-pages" // opened fine, but exceeds MAX_PAGES
  | "page-render-error" // a specific page failed to render
  | "unexpected"; // anything else

export class DocumentRenderError extends Error {
  readonly kind: RenderErrorKind;
  /** 1-based page number, when the error is tied to a specific page. */
  readonly page?: number;

  constructor(
    kind: RenderErrorKind,
    message: string,
    options: { cause?: unknown; page?: number } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "DocumentRenderError";
    this.kind = kind;
    this.page = options.page;
  }
}

export type RenderedPage = {
  /** 1-based, in document order. */
  pageNumber: number;
  /** Pixel width of the rendered JPEG. */
  width: number;
  /** Pixel height of the rendered JPEG. */
  height: number;
  /** JPEG image bytes. */
  jpeg: Uint8Array;
};

export type RenderEvent =
  | { type: "document-parsed"; pageCount: number }
  | { type: "page-rendering"; pageNumber: number; pageCount: number }
  | { type: "page-rendered"; page: RenderedPage };

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * MuPDF picks a handler from a "magic" hint: a file name, extension or MIME
 * type. The file name is the most reliable signal from a browser upload (the
 * MIME type is often empty or `application/octet-stream`), so it wins.
 */
function formatHint(fileName: string, mimeType: string): string {
  if (/\.[a-z0-9]+$/i.test(fileName)) return fileName;
  if (mimeType && mimeType !== "application/octet-stream") return mimeType;
  return fileName || "application/pdf";
}

const RASTER_HINT = /(\.(png|jpe?g|tiff?|bmp|gif|webp|jxr|jp2|jpx|pbm|pgm|ppm|pnm|psd)$)|^image\/(?!svg)/i;

/**
 * Native long edge in pixels for a raster image upload, or null for anything
 * else. MuPDF sizes an image page from its DPI metadata, which is often a
 * placeholder 72, so rendering at `dpi` would upscale the pixels — adding bytes
 * and blur, never detail. Knowing the native size lets the caller cap the zoom.
 */
function rasterLongEdgePx(data: Uint8Array, hint: string): number | null {
  if (!RASTER_HINT.test(hint)) return null;
  let image: mupdf.Image | undefined;
  try {
    image = new mupdf.Image(data);
    return Math.max(image.getWidth(), image.getHeight());
  } catch {
    return null; // let openDocument report the real problem
  } finally {
    image?.destroy();
  }
}

/**
 * Render every page of a document to a JPEG buffer, in order, at ~`dpi`
 * resolution (capped at {@link MAX_LONG_EDGE_PX} on the long edge).
 *
 * Yields progress events as it goes so a caller can stream status to the client.
 * Throws `DocumentRenderError` on any failure — a partial result is never
 * returned.
 */
export async function* renderDocumentToImages(
  data: Uint8Array,
  opts: { fileName?: string; mimeType?: string; dpi?: number } = {},
): AsyncGenerator<RenderEvent, void, void> {
  const dpi = opts.dpi ?? DEFAULT_DPI;
  const hint = formatHint(opts.fileName ?? "", opts.mimeType ?? "");

  if (data.length === 0) {
    throw new DocumentRenderError("corrupt-document", "Uploaded file is empty.");
  }

  let doc: mupdf.Document;
  try {
    doc = mupdf.Document.openDocument(data, hint);
  } catch (err) {
    const message = errMessage(err);
    // MuPDF reports a missing handler as "cannot find document handler for
    // file type"; anything else means it recognised the type but failed.
    const unsupported = /document handler|unknown document type/i.test(message);
    throw new DocumentRenderError(
      unsupported ? "unsupported-format" : "corrupt-document",
      unsupported
        ? `This file type is not supported (${hint}): ${message}`
        : `MuPDF could not open the document: ${message}`,
      { cause: err },
    );
  }

  try {
    let encrypted = false;
    try {
      encrypted = doc.needsPassword();
    } catch (err) {
      throw new DocumentRenderError(
        "parse-error",
        `Could not determine encryption status: ${errMessage(err)}`,
        { cause: err },
      );
    }
    if (encrypted) {
      throw new DocumentRenderError(
        "encrypted-document",
        "Document is encrypted / password protected. Remove the password and retry.",
      );
    }

    let pageCount: number;
    try {
      // Reflowable formats need a page size before they have pages at all;
      // fixed-layout formats ignore this call.
      doc.layout(LAYOUT_WIDTH_PT, LAYOUT_HEIGHT_PT, LAYOUT_EM_PT);
      pageCount = doc.countPages();
    } catch (err) {
      throw new DocumentRenderError(
        "parse-error",
        `Could not read the page count: ${errMessage(err)}`,
        { cause: err },
      );
    }
    if (!Number.isInteger(pageCount) || pageCount < 1) {
      throw new DocumentRenderError(
        "parse-error",
        `Document reports an invalid page count (${pageCount}).`,
      );
    }
    if (pageCount > MAX_PAGES) {
      throw new DocumentRenderError(
        "too-many-pages",
        `Document has ${pageCount} pages; at most ${MAX_PAGES} can be read in one request.`,
      );
    }

    yield { type: "document-parsed", pageCount };

    const nativeLongEdgePx = rasterLongEdgePx(data, hint);

    for (let i = 0; i < pageCount; i++) {
      const pageNumber = i + 1;
      yield { type: "page-rendering", pageNumber, pageCount };

      let page: mupdf.Page | mupdf.PDFPage | undefined;
      let pixmap: mupdf.Pixmap | undefined;
      let jpeg: Uint8Array;
      let width: number;
      let height: number;
      try {
        page = doc.loadPage(i);
        // MuPDF's base user space is 72 DPI. Shrink the zoom for oversized
        // pages so the long edge never exceeds MAX_LONG_EDGE_PX, and never
        // upscale a raster image past its own pixels.
        const [x0, y0, x1, y1] = page.getBounds();
        const longEdgePt = Math.max(x1 - x0, y1 - y0);
        const zoom = Math.min(
          dpi / 72,
          MAX_LONG_EDGE_PX / longEdgePt,
          (nativeLongEdgePx ?? Infinity) / longEdgePt,
        );
        pixmap = page.toPixmap(
          mupdf.Matrix.scale(zoom, zoom),
          mupdf.ColorSpace.DeviceRGB,
          false, // no alpha -> white background
        );
        width = pixmap.getWidth();
        height = pixmap.getHeight();
        jpeg = pixmap.asJPEG(JPEG_QUALITY);
      } catch (err) {
        throw new DocumentRenderError(
          "page-render-error",
          `Failed to render page ${pageNumber} of ${pageCount}: ${errMessage(err)}`,
          { cause: err, page: pageNumber },
        );
      } finally {
        pixmap?.destroy();
        page?.destroy();
      }

      if (!jpeg || jpeg.length === 0) {
        throw new DocumentRenderError(
          "page-render-error",
          `Page ${pageNumber} of ${pageCount} produced an empty image.`,
          { page: pageNumber },
        );
      }

      yield {
        type: "page-rendered",
        page: { pageNumber, width, height, jpeg },
      };
    }
  } finally {
    doc.destroy();
  }
}
