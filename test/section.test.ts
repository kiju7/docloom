/**
 * 섹션/용지/다단 파싱 + 페이지 미리보기 반영 테스트.
 */
import { describe, it, expect } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { parseSectionProps } from "../src/docx/section.js";
import { parseXml, findBody, splitBodyChildren } from "../src/docx/ooxml.js";
import { docxToPreviewHtml } from "../src/index.js";

function sectXml(sectInner: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p><w:r><w:t>x</w:t></w:r></w:p><w:sectPr>${sectInner}</w:sectPr></w:body></w:document>`;
}

function parse(sectInner: string) {
  const doc = parseXml(sectXml(sectInner));
  const { sectPr } = splitBodyChildren(findBody(doc));
  return parseSectionProps(sectPr);
}

describe("섹션 속성 파싱", () => {
  it("용지 크기·여백·gutter 를 px 로 환산한다", () => {
    const s = parse(`<w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:gutter="720"/>`);
    expect(s.page.wPx).toBe(794); // 11906 tw * 96/1440
    expect(s.page.topPx).toBe(96); // 1440 tw = 1in = 96px
    expect(s.gutterPx).toBe(48);
  });

  it("가로 방향(orientation)을 인식한다", () => {
    const s = parse(`<w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/>`);
    expect(s.orient).toBe("landscape");
    expect(s.page.wPx).toBeGreaterThan(s.page.hPx);
  });

  it("다단(w:cols)을 파싱한다 — 단 수·간격·구분선", () => {
    const s = parse(`<w:cols w:num="2" w:space="708" w:sep="1"/>`);
    expect(s.cols.num).toBe(2);
    expect(s.cols.sep).toBe(true);
    expect(s.cols.space).toBe(47); // 708 tw
  });

  it("페이지 테두리를 CSS 로 변환한다", () => {
    const s = parse(`<w:pgBorders><w:top w:val="single" w:sz="24" w:color="FF0000"/><w:bottom w:val="single" w:sz="24" w:color="auto"/></w:pgBorders>`);
    expect(s.borders?.top).toMatch(/px solid #FF0000/);
    expect(s.borders?.bottom).toMatch(/px solid #000/);
  });

  it("기본값은 A4 세로 1단", () => {
    const s = parse(``);
    expect(s.orient).toBe("portrait");
    expect(s.cols.num).toBe(1);
  });
});

describe("페이지 미리보기에 섹션이 반영된다", () => {
  const styles = `<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>`;
  const docXml = sectXml(`<w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/><w:cols w:num="3" w:space="360" w:sep="1"/>`);
  const docx = zipSync({
    "[Content_Types].xml": strToU8(`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`),
    "_rels/.rels": strToU8(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`),
    "word/styles.xml": strToU8(styles),
    "word/document.xml": strToU8(docXml),
  });

  it("단일 단 문서는 --cols:auto 로 둬 페이지 분할을 깨지 않는다", () => {
    const single = zipSync({
      "[Content_Types].xml": strToU8(`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`),
      "_rels/.rels": strToU8(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`),
      "word/styles.xml": strToU8(styles),
      "word/document.xml": strToU8(sectXml(`<w:cols w:space="720"/>`)),
    });
    const html = docxToPreviewHtml(single, { layout: "paged" });
    expect(html).toContain("--cols:auto");
    expect(html).not.toContain("--cols:1;");
  });

  it("다단·가로방향이 paged HTML 의 CSS 변수로 들어간다", () => {
    const html = docxToPreviewHtml(docx, { layout: "paged" });
    expect(html).toContain("--cols:3");
    expect(html).toContain("--colrule:1px solid");
    // 가로: 폭 변수(--pw)가 높이(--ph)보다 큼
    const pw = Number(/--pw:(\d+)px/.exec(html)?.[1]);
    const ph = Number(/--ph:(\d+)px/.exec(html)?.[1]);
    expect(pw).toBeGreaterThan(ph);
  });
});
