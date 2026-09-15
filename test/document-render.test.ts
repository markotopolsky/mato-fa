import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DocumentRenderError,
  MAX_LONG_EDGE_PX,
  renderDocumentToImages,
} from "../app/lib/document-render.ts";

/** Build a minimal valid multi-page PDF (Helvetica, one line + border per page). */
function buildPdf(pageCount: number): Uint8Array {
  const objs: string[] = [];
  const add = (s: string) => (objs.push(s), objs.length);

  add(""); // 1 Catalog (filled later)
  add(""); // 2 Pages (filled later)
  const fontNum = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");

  const kids: string[] = [];
  for (let i = 1; i <= pageCount; i++) {
    const s = `BT /F1 24 Tf 72 720 Td (Page ${i} of ${pageCount}) Tj ET\n72 72 451 648 re S`;
    const content = add(`<< /Length ${Buffer.byteLength(s)} >>\nstream\n${s}\nendstream`);
    const page = add(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 792] ` +
        `/Resources << /Font << /F1 ${fontNum} 0 R >> >> /Contents ${content} 0 R >>`,
    );
    kids.push(`${page} 0 R`);
  }
  objs[0] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${kids.length} >>`;

  let pdf = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
  const offsets: number[] = [];
  objs.forEach((body, i) => {
    offsets[i] = Buffer.byteLength(pdf, "latin1");
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) pdf += `${String(o).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new Uint8Array(Buffer.from(pdf, "latin1"));
}

const JPEG_SOI = [0xff, 0xd8, 0xff];

async function renderAll(bytes: Uint8Array, fileName = "document.pdf", dpi?: number) {
  let pageCount = -1;
  const pages: { pageNumber: number; jpeg: Uint8Array; width: number; height: number }[] = [];
  for await (const ev of renderDocumentToImages(bytes, { fileName, dpi })) {
    if (ev.type === "document-parsed") pageCount = ev.pageCount;
    else if (ev.type === "page-rendered") pages.push(ev.page);
  }
  return { pageCount, pages };
}

for (const n of [1, 3, 10]) {
  test(`renders every page of a ${n}-page PDF`, async () => {
    const { pageCount, pages } = await renderAll(buildPdf(n));

    // page count === rendered image count
    assert.equal(pageCount, n);
    assert.equal(pages.length, n);

    // order preserved
    assert.deepEqual(
      pages.map((p) => p.pageNumber),
      Array.from({ length: n }, (_, i) => i + 1),
    );

    // every image is non-empty and actually a JPEG
    for (const { pageNumber, jpeg } of pages) {
      assert.ok(jpeg.length > 0, `page ${pageNumber} image is empty`);
      assert.deepEqual([...jpeg.slice(0, 3)], JPEG_SOI, `page ${pageNumber} bad JPEG signature`);
    }
  });
}

test("caps the long edge at MAX_LONG_EDGE_PX", async () => {
  const { pages } = await renderAll(buildPdf(1), "document.pdf", 300);
  assert.equal(Math.max(pages[0].width, pages[0].height), MAX_LONG_EDGE_PX);
});

test("never upscales a raster image past its native pixels", async () => {
  // Render a page, then feed the JPEG back in as an image upload.
  const { pages: [source] } = await renderAll(buildPdf(1), "document.pdf", 100);
  const { pageCount, pages } = await renderAll(source.jpeg, "scan.jpg", 300);
  assert.equal(pageCount, 1);
  assert.equal(pages[0].width, source.width);
  assert.equal(pages[0].height, source.height);
});

test("rejects an unknown file type with kind=unsupported-format", async () => {
  await assert.rejects(
    () => renderAll(new Uint8Array(Buffer.from("not a document")), "notes.xyz"),
    (e: unknown) => e instanceof DocumentRenderError && e.kind === "unsupported-format",
  );
});

test("rejects a broken PDF with kind=corrupt-document", async () => {
  await assert.rejects(
    () => renderAll(new Uint8Array(Buffer.from("not a pdf")), "broken.pdf"),
    (e: unknown) => e instanceof DocumentRenderError && e.kind === "corrupt-document",
  );
});
