import { describe, it, expect } from "vitest";
import { zlibSync } from "fflate";
import { extractPdfModel, buildPdfFromModel } from "../src/index.js";

const te = new TextEncoder();

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
function buildPdf(objs: { num: number; dict: string; stream?: Uint8Array }[]): Uint8Array {
  const parts: Uint8Array[] = [te.encode("%PDF-1.5\n")];
  for (const o of objs) {
    if (o.stream) {
      parts.push(te.encode(`${o.num} 0 obj ${o.dict} stream\n`));
      parts.push(o.stream);
      parts.push(te.encode(`\nendstream endobj\n`));
    } else parts.push(te.encode(`${o.num} 0 obj ${o.dict} endobj\n`));
  }
  parts.push(te.encode(`trailer << /Root 1 0 R >>\n%%EOF`));
  return concatBytes(parts);
}

/** Latin + 한글(UCS2 CID) + 이미지 1장이 든 합성 PDF. */
function sourcePdf(): Uint8Array {
  const rgb = zlibSync(new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255])); // 2×2
  const content = te.encode(
    "q 100 0 0 60 40 20 cm /Im0 Do Q " + // 이미지
    "0 0 0 rg 10 10 200 0.5 re f " + // 벡터 선
    "BT /F1 14 Tf 1 0 0 1 40 120 Tm (Hello) Tj ET " + // Latin
    "BT /F2 16 Tf 1 0 0 1 40 150 Tm <AC00B098B2E4> Tj ET", // 가나다
  );
  return buildPdf([
    { num: 1, dict: "<< /Type /Catalog /Pages 2 0 R >>" },
    { num: 2, dict: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>" },
    { num: 3, dict: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R /F2 6 0 R >> /XObject << /Im0 7 0 R >> >> /Contents 5 0 R >>" },
    { num: 4, dict: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>" },
    { num: 6, dict: "<< /Type /Font /Subtype /Type0 /BaseFont /HYSMyeongJo-Medium /Encoding /UniKS-UCS2-H /DescendantFonts [8 0 R] >>" },
    { num: 8, dict: "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /HYSMyeongJo-Medium /DW 1000 >>" },
    { num: 7, dict: `<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${rgb.length} >>`, stream: rgb },
    { num: 5, dict: `<< /Length ${content.length} >>`, stream: content },
  ]);
}

describe("PDF 생성기 (편집 → 새 PDF)", () => {
  it("추출 → 재생성 → 재추출 시 텍스트·이미지·경로가 보존된다", () => {
    const model = extractPdfModel(sourcePdf());
    expect(model.pages.length).toBe(1);
    const glyphs0 = model.pages[0]!.items.map((i) => i.text).join("");
    expect(glyphs0).toContain("Hello");
    expect(glyphs0).toContain("가나다");

    const regenerated = buildPdfFromModel(model);
    // %PDF 헤더로 시작하는 유효 PDF
    expect([...regenerated.subarray(0, 5)]).toEqual([...te.encode("%PDF-")]);

    // 재추출해서 동일 내용 확인(왕복 일관성)
    const model2 = extractPdfModel(regenerated);
    const glyphs1 = model2.pages[0]!.items.map((i) => i.text).join("");
    expect(glyphs1).toContain("Hello");
    expect(glyphs1).toContain("가나다");
    expect(model2.pages[0]!.images.length).toBe(1); // 이미지 재방출됨
    expect(model2.pages[0]!.paths.length).toBeGreaterThanOrEqual(1); // 벡터 재방출됨
  });

  it("텍스트를 편집하면 새 PDF 에 반영된다", () => {
    const model = extractPdfModel(sourcePdf());
    // 인접 글자는 런으로 결합 → "Hello" 를 담은 런을 찾아 통째로 교체
    const run = model.pages[0]!.items.find((i) => i.text.includes("Hello"));
    expect(run).toBeTruthy();
    run!.text = run!.text.replace("Hello", "World");

    const out = buildPdfFromModel(model);
    const re = extractPdfModel(out);
    const g = re.pages[0]!.items.map((i) => i.text).join("");
    expect(g).toContain("World");
    expect(g).not.toContain("Hello");
  });
});
