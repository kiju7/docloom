/**
 * 이미지·도형 런 frozen 처리 — LLM 편집 HTML 엔 자리표시자만(토큰 절약),
 * 왕복 후 원본 이미지(w:drawing)는 그대로 복원됨을 검증.
 */
import { describe, it, expect } from "vitest";
import { zipSync, strToU8, unzipSync, strFromU8 } from "fflate";
import { encodeToHtml, decodeToDocx } from "../src/index.js";

const styles = `<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>`;

// 그림이 든 문단 + 텍스트 문단
const documentXml = `<?xml version="1.0"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
<w:body>
<w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr><w:r><w:t xml:space="preserve">아래는 차트 그림입니다: </w:t></w:r><w:r><w:drawing><wp:inline xmlns:wp="x"><a:graphic><a:graphicData><pic:pic xmlns:pic="y"><pic:blipFill><a:blip r:embed="rId99"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>
<w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr><w:r><w:t>다음 문단.</w:t></w:r></w:p>
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>
</w:body></w:document>`;

function makeDocx(): Uint8Array {
  return zipSync({
    "[Content_Types].xml": strToU8(`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`),
    "_rels/.rels": strToU8(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`),
    "word/styles.xml": strToU8(styles),
    "word/document.xml": strToU8(documentXml),
  });
}

const docXml = (bytes: Uint8Array) => strFromU8(unzipSync(bytes)["word/document.xml"]!);

describe("이미지 런 frozen", () => {
  it("LLM 편집 HTML 엔 자리표시자만 — 이미지/drawing 바이트가 안 나간다", () => {
    const { html, manifest } = encodeToHtml(makeDocx());
    expect(html).toContain('data-frozen-run');
    expect(html).toContain("[그림]");
    // HTML 에는 drawing/blip 이 절대 없어야 함(토큰 절약)
    expect(html).not.toContain("w:drawing");
    expect(html).not.toContain("a:blip");
    // 원본은 manifest 에 보관
    const fr = Object.keys(manifest.frozen).find((k) => k.startsWith("frun-"));
    expect(fr).toBeTruthy();
    expect(manifest.frozen[fr!]).toContain("w:drawing");
  });

  it("왕복 후 원본 이미지(w:drawing·blip rId)가 그대로 복원된다", () => {
    const { html, manifest } = encodeToHtml(makeDocx());
    const out = decodeToDocx(html, manifest);
    const xml = docXml(out);
    expect(xml).toContain("w:drawing");
    expect(xml).toMatch(/r:embed="rId99"/);
    // 같은 문단의 텍스트도 유지
    expect(xml).toContain("아래는 차트 그림입니다");
    expect(xml).toContain("다음 문단.");
  });
});
