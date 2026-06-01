/**
 * 직접서식 라운드트립 보존 테스트.
 *
 * 정렬(w:jc)·들여쓰기(w:ind)·간격(w:spacing)·번호매기기(w:numPr)와
 * 런 서식(색 w:color·크기 w:sz)이 docx → html → docx 왕복 후에도
 * 살아남는지 검증한다. (Manifest 속성 보존 방식)
 */
import { describe, it, expect } from "vitest";
import { zipSync, strToU8, unzipSync, strFromU8 } from "fflate";
import { encodeToHtml, decodeToDocx } from "../src/index.js";

const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>`;

const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`;

const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;

const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;

const body = `<w:p><w:pPr><w:pStyle w:val="Normal"/><w:jc w:val="center"/><w:ind w:left="720"/><w:spacing w:before="240" w:after="120"/></w:pPr><w:r><w:t>가운데 정렬·들여쓰기 문단</w:t></w:r></w:p>` +
  `<w:p><w:pPr><w:pStyle w:val="Normal"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>번호 항목</w:t></w:r></w:p>` +
  `<w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr><w:r><w:rPr><w:color w:val="FF0000"/><w:sz w:val="32"/></w:rPr><w:t>빨강 큰 글씨</w:t></w:r></w:p>` +
  `<w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr><w:r><w:rPr><w:color w:val="00B050"/><w:b/></w:rPr><w:t>초록 굵게</w:t></w:r></w:p>`;

const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`;

function makeDocx(): Uint8Array {
  return zipSync({
    "[Content_Types].xml": strToU8(contentTypes),
    "_rels/.rels": strToU8(rels),
    "word/_rels/document.xml.rels": strToU8(docRels),
    "word/styles.xml": strToU8(styles),
    "word/document.xml": strToU8(documentXml),
  });
}

function readDocumentXml(docx: Uint8Array): string {
  return strFromU8(unzipSync(docx)["word/document.xml"]!);
}

describe("직접서식 라운드트립 보존", () => {
  it("encode 가 직접서식을 토큰화해 manifest.props 에 보관하고 HTML 에 토큰을 싣는다", () => {
    const { html, manifest } = encodeToHtml(makeDocx());

    // 문단 직접서식 2개(정렬·들여쓰기·간격 / 번호) → pp 토큰, pStyle 만 있는 문단은 토큰 없음
    expect(Object.keys(manifest.props).filter((k) => k.startsWith("pp-"))).toHaveLength(2);
    // 런 직접서식 2개(빨강+크기 / 초록+굵게) → rp 토큰
    expect(Object.keys(manifest.props).filter((k) => k.startsWith("rp-"))).toHaveLength(2);

    expect(html).toContain('data-pp="pp-0"');
    expect(html).toContain('data-rp="rp-0"');
    // 보관된 원본 조각에 실제 서식이 들어있다
    expect(manifest.props["pp-0"]).toContain('w:jc');
    expect(manifest.props["rp-0"]).toContain('w:color');
  });

  it("docx → html → docx 왕복 후 정렬·들여쓰기·간격·번호·색·크기가 보존된다", () => {
    const { html, manifest } = encodeToHtml(makeDocx());
    const rebuilt = decodeToDocx(html, manifest);
    const xml = readDocumentXml(rebuilt);

    // 문단 서식
    expect(xml).toContain('w:jc');
    expect(xml).toMatch(/w:jc[^>]*w:val="center"/);
    expect(xml).toContain('w:ind');
    expect(xml).toMatch(/w:left="720"/);
    expect(xml).toContain('w:spacing');
    expect(xml).toContain('w:numPr');
    expect(xml).toMatch(/w:numId[^>]*w:val="1"/);
    // 런 서식
    expect(xml).toMatch(/w:color[^>]*w:val="FF0000"/);
    expect(xml).toMatch(/w:sz[^>]*w:val="32"/);
    // 색 + 마크 결합 보존
    expect(xml).toMatch(/w:color[^>]*w:val="00B050"/);
    expect(xml).toContain('w:b');
  });

  it("왕복 후 pStyle 이 현재 styleKey 로 유지된다(스타일 깨짐 없음)", () => {
    const { html, manifest } = encodeToHtml(makeDocx());
    const xml = readDocumentXml(decodeToDocx(html, manifest));
    // 모든 문단이 Normal 스타일을 유지
    expect((xml.match(/w:pStyle[^>]*w:val="Normal"/g) ?? []).length).toBe(4);
  });
});
