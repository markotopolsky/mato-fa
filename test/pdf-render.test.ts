import assert from "node:assert/strict";
import { test } from "node:test";
import { renderPdfToPngPages, PdfRenderError } from "../app/lib/pdf-render.ts";

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

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

async function renderAll(bytes: Uint8Array) {
  let pageCount = -1;
  const pngs: { pageNumber: number; png: Uint8Array }[] = [];
  for await (const ev of renderPdfToPngPages(bytes)) {
    if (ev.type === "pdf-parsed") pageCount = ev.pageCount;
    else if (ev.type === "page-rendered")
      pngs.push({ pageNumber: ev.page.pageNumber, png: ev.page.png });
  }
  return { pageCount, pngs };
}

for (const n of [1, 3, 10]) {
  test(`renders every page of a ${n}-page PDF`, async () => {
    const { pageCount, pngs } = await renderAll(buildPdf(n));

    // page count === rendered PNG count
    assert.equal(pageCount, n);
    assert.equal(pngs.length, n);

    // order preserved
    assert.deepEqual(
      pngs.map((p) => p.pageNumber),
      Array.from({ length: n }, (_, i) => i + 1),
    );

    // every PNG is non-empty and actually a PNG
    for (const { pageNumber, png } of pngs) {
      assert.ok(png.length > 0, `page ${pageNumber} PNG is empty`);
      assert.deepEqual([...png.slice(0, 8)], PNG_SIG, `page ${pageNumber} bad PNG signature`);
    }
  });
}

test("rejects a non-PDF with kind=invalid-pdf", async () => {
  await assert.rejects(
    () => renderAll(new Uint8Array(Buffer.from("not a pdf"))),
    (e: unknown) => e instanceof PdfRenderError && e.kind === "invalid-pdf",
  );
});
