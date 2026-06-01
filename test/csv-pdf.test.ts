import { describe, it, expect } from "vitest";
import { detectContainer } from "../src/core/detect.js";
import { adapterFor, encode, decode, previewHtml } from "../src/index.js";
import { csvEncode, csvDecode, parseCsv, sniffDialect } from "../src/formats/csv.js";
import { zlibSync } from "fflate";

const te = new TextEncoder();
const td = new TextDecoder();

describe("컨테이너 판별 — csv/pdf", () => {
  it("평문은 text, %PDF 는 pdf 로 판별", () => {
    expect(detectContainer(te.encode("a,b,c\n1,2,3\n"))).toBe("text");
    expect(detectContainer(te.encode("%PDF-1.4\n..."))).toBe("pdf");
  });
  it("adapterFor 가 평문→csv, %PDF→pdf 어댑터로 라우팅", () => {
    expect(adapterFor(te.encode("a,b\n1,2")).id).toBe("csv");
    expect(adapterFor(te.encode("%PDF-1.7\n")).id).toBe("pdf");
  });
});

describe("CSV RFC4180 파서", () => {
  it("따옴표·구분자·줄바꿈 포함 필드", () => {
    const rows = parseCsv('a,"b,c","d""e",f\n1,2,3,4', ",");
    expect(rows[0]).toEqual(["a", "b,c", 'd"e', "f"]);
    expect(rows[1]).toEqual(["1", "2", "3", "4"]);
  });
  it("셀 안 줄바꿈(따옴표 안)", () => {
    const rows = parseCsv('"line1\nline2",x', ",");
    expect(rows[0]).toEqual(["line1\nline2", "x"]);
  });
  it("방언 감지 — 세미콜론 + CRLF + BOM", () => {
    const d = sniffDialect("﻿a;b;c\r\n1;2;3\r\n");
    expect(d.delimiter).toBe(";");
    expect(d.eol).toBe("\r\n");
    expect(d.bom).toBe(true);
  });
});

describe("CSV 왕복 1급 (값 무손실)", () => {
  const sources = [
    "name,age,city\r\nAlice,30,Seoul\r\nBob,25,Busan\r\n",
    '제품,설명,가격\n"커피, 원두","향이 좋은\n블렌드",12000\n',
    "﻿a;b;c\r\n1;2;3\r\n", // BOM + 세미콜론 + CRLF
  ];
  for (const [i, src] of sources.entries()) {
    it(`source #${i} 의 셀 값이 왕복에서 보존된다`, () => {
      const bytes = te.encode(src);
      const { html, manifest } = csvEncode(bytes);
      const out = csvDecode(html, manifest);
      const d = sniffDialect(src);
      // BOM 은 바이트 수준으로 검증(TextDecoder 는 선행 BOM 을 벗겨내므로).
      const hasBom = out[0] === 0xef && out[1] === 0xbb && out[2] === 0xbf;
      expect(hasBom).toBe(d.bom);
      // 셀 값 동일성(BOM 제외 본문 비교)
      const want = parseCsv(d.bom ? src.slice(1) : src, d.delimiter);
      const body = hasBom ? td.decode(out.subarray(3)) : td.decode(out);
      expect(parseCsv(body, d.delimiter)).toEqual(want);
    });
  }

  it("제네릭 encode/decode 경로도 동작(manifest.format=csv)", () => {
    const bytes = te.encode("x,y\n1,2\n");
    const { html, manifest } = encode(bytes);
    expect(manifest.format).toBe("csv");
    const out = decode(html, manifest); // format 미지정 → manifest.format 사용
    expect(parseCsv(td.decode(out), ",")).toEqual([["x", "y"], ["1", "2"]]);
  });
});

// ── 최소 PDF(비압축) 합성: brute-scan + 콘텐츠 해석 경로 검증 ──
function miniPdf(): Uint8Array {
  const pdf = `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj
4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
5 0 obj << >> stream
BT /F1 12 Tf 20 50 Td (Hello PDF) Tj ET
endstream
endobj
trailer << /Root 1 0 R >>
%%EOF`;
  return te.encode(pdf);
}

/** pdf-t 글리프 span 들의 텍스트를 순서대로 이어붙인다(공백 글리프는 제외되어 빠짐). */
function glyphText(html: string): string {
  return [...html.matchAll(/<span class="pdf-t"[^>]*>([^<]*)<\/span>/g)].map((m) => m[1]).join("");
}

describe("PDF T2 위치보존 추출", () => {
  it("텍스트와 좌표를 추출한다", async () => {
    const bytes = miniPdf();
    expect(detectContainer(bytes)).toBe("pdf");
    const html = previewHtml(bytes);
    // 인접 글자는 런으로 결합(공백 보존) → "Hello PDF"
    expect(glyphText(html)).toBe("Hello PDF");
    // 절대배치 span 이 생성되고, 첫 글자 H 의 x≈20pt→약 26.7px
    expect(html).toMatch(/class="pdf-t"/);
    expect(html).toMatch(/left:2[0-9]\.\d+px/); // 20pt * 1.333 ≈ 26.7px
  });

  it("FlateDecode 압축 콘텐츠 스트림도 해제·추출한다", () => {
    const content = te.encode("BT /F1 10 Tf 10 80 Td (Zipped) Tj ET");
    const deflated = zlibSync(content);
    // 스트림 바이트를 그대로 끼우기 위해 헤더/바디를 바이트로 조립
    const head = te.encode(
      `%PDF-1.5
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj
4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
5 0 obj << /Filter /FlateDecode /Length ${deflated.length} >> stream
`,
    );
    const tail = te.encode("\nendstream\nendobj\ntrailer << /Root 1 0 R >>\n%%EOF");
    const buf = new Uint8Array(head.length + deflated.length + tail.length);
    buf.set(head, 0);
    buf.set(deflated, head.length);
    buf.set(tail, head.length + deflated.length);

    const html = previewHtml(buf);
    expect(glyphText(html)).toBe("Zipped");
  });
});
