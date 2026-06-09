import { describe, it, expect } from "vitest";
import { docxToPreviewHtml, extractStyleCss, renderPreviewBody, DEFAULT_PALETTE } from "../src/index.js";
import { unzipSync } from "fflate";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const SAMPLE = join(here, "fixtures", "sample.docx");
const hasSample = existsSync(SAMPLE);
const loadSample = () => new Uint8Array(readFileSync(SAMPLE));

describe("미리보기 + styles.xml CSS 추출", () => {
  it.runIf(hasSample)("docxToPreviewHtml 은 자체 완결 HTML 페이지를 만든다", () => {
    const html = docxToPreviewHtml(loadSample(), { title: "테스트" });
    expect(html).toMatch(/^<!DOCTYPE html>/);
    expect(html).toContain("<title>테스트</title>");
    expect(html).toContain('class="docloom-doc"');
    expect(html).toContain("<style>");
  });

  it.runIf(hasSample)("원본 styles.xml 의 실제 크기·굵기를 CSS 로 추출한다", () => {
    const stylesXml = new TextDecoder().decode(unzipSync(loadSample())["word/styles.xml"]!);
    const css = extractStyleCss(stylesXml, DEFAULT_PALETTE);

    // Title: w:sz=56 → 28pt
    expect(css).toMatch(/\.s-title\s*\{[^}]*font-size:28pt/);
    // Heading1: w:sz=32 → 16pt, w:b → 700
    expect(css).toMatch(/\.s-heading1\s*\{[^}]*font-size:16pt/);
    expect(css).toMatch(/\.s-heading1\s*\{[^}]*font-weight:700/);
  });

  it("styles.xml 이 없으면 빈 문자열(폴백 사용)을 반환한다", () => {
    expect(extractStyleCss(undefined, DEFAULT_PALETTE)).toBe("");
  });
});

// ── 목록 마커 충실도 ────────────────────────────────────────────────────────

const enc = (s: string) => new TextEncoder().encode(s);
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

function makeParts(opts: { docBody: string; numbering?: string; styles?: string }): Record<string, Uint8Array> {
  const parts: Record<string, Uint8Array> = {
    "word/document.xml": enc(`<w:document ${W}><w:body>${opts.docBody}<w:sectPr/></w:body></w:document>`),
  };
  if (opts.numbering) parts["word/numbering.xml"] = enc(`<w:numbering ${W}>${opts.numbering}</w:numbering>`);
  if (opts.styles) parts["word/styles.xml"] = enc(`<w:styles ${W}>${opts.styles}</w:styles>`);
  return parts;
}

const numbering = (lvlText: string, opts: { font?: string; fmt?: string } = {}) =>
  `<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0">` +
  `<w:numFmt w:val="${opts.fmt ?? "bullet"}"/><w:lvlText w:val="${lvlText}"/>` +
  (opts.font ? `<w:rPr><w:rFonts w:ascii="${opts.font}" w:hAnsi="${opts.font}"/></w:rPr>` : "") +
  `</w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>`;

const numParaDirect = `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>항목</w:t></w:r></w:p>`;

describe("목록 마커 충실도", () => {
  it("글머리표는 하드코딩 • 가 아니라 실제 lvlText('-') 를 렌더한다", () => {
    const body = renderPreviewBody(makeParts({ docBody: numParaDirect, numbering: numbering("-") }), DEFAULT_PALETTE).body;
    expect(body).toContain(">-</span>");
    expect(body).not.toContain(">•</span>");
  });

  it("Wingdings/Symbol 사유영역 글머리표는 유니코드 불릿으로 매핑한다", () => {
    // U+F0A7 (Wingdings 작은 사각) → ▪
    const body = renderPreviewBody(
      makeParts({ docBody: numParaDirect, numbering: numbering("", { font: "Wingdings" }) }),
      DEFAULT_PALETTE,
    ).body;
    expect(body).toContain(">▪</span>");
  });

  it("문단 직접 numPr 가 없어도 스타일(pStyle)에 박힌 numPr 로 마커를 렌더한다", () => {
    const styleParaInherit = `<w:p><w:pPr><w:pStyle w:val="ListPara"/></w:pPr><w:r><w:t>항목</w:t></w:r></w:p>`;
    const styles = `<w:style w:type="paragraph" w:styleId="ListPara"><w:name w:val="ListPara"/>` +
      `<w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr></w:style>`;
    const body = renderPreviewBody(
      makeParts({ docBody: styleParaInherit, numbering: numbering("•"), styles }),
      DEFAULT_PALETTE,
    ).body;
    expect(body).toContain('class="docloom-marker"');
  });

  it("numId='0'(번호 제거) 은 마커를 만들지 않는다", () => {
    const zeroNum = `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="0"/></w:numPr></w:pPr><w:r><w:t>x</w:t></w:r></w:p>`;
    const body = renderPreviewBody(makeParts({ docBody: zeroNum, numbering: numbering("-") }), DEFAULT_PALETTE).body;
    expect(body).not.toContain('class="docloom-marker"');
  });

  it("번호 레벨의 들여쓰기(w:ind)를 목록 문단에 적용한다(내어쓰기 포함)", () => {
    const numWithInd =
      `<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0">` +
      `<w:numFmt w:val="bullet"/><w:lvlText w:val="-"/>` +
      `<w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr>` +
      `</w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>`;
    const body = renderPreviewBody(makeParts({ docBody: numParaDirect, numbering: numWithInd }), DEFAULT_PALETTE).body;
    expect(body).toMatch(/margin-left:36pt/); // 720 twips / 20
    expect(body).toMatch(/text-indent:-18pt/); // hanging 360 / 20
  });
});

// ── 표 테두리 충실도 ────────────────────────────────────────────────────────

describe("표·셀 테두리", () => {
  it("셀의 tcBorders(색·변별·nil)를 인라인 border 로 렌더하고 회색 기본 테두리를 끈다", () => {
    const tbl =
      `<w:tbl><w:tblGrid><w:gridCol/></w:tblGrid>` +
      `<w:tr><w:tc><w:tcPr><w:tcBorders>` +
      `<w:top w:val="single" w:sz="36" w:color="000080"/><w:left w:val="nil"/>` +
      `<w:bottom w:val="thickThinSmallGap" w:sz="36" w:color="333399"/><w:right w:val="nil"/>` +
      `</w:tcBorders></w:tcPr><w:p><w:r><w:t>제목</w:t></w:r></w:p></w:tc></w:tr></w:tbl>`;
    const body = renderPreviewBody(makeParts({ docBody: tbl }), DEFAULT_PALETTE).body;
    expect(body).toContain("docloom-table-bordered");
    expect(body).toMatch(/border-top:4\.5pt solid #000080/); // sz 36/8 = 4.5pt
    expect(body).toMatch(/border-left:none/);
    expect(body).toMatch(/border-bottom:4\.5pt double #333399/); // thickThin → double
  });

  it("표 스타일(tblStyle)의 tblBorders 를 셀 테두리로 적용한다", () => {
    const styles =
      `<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/>` +
      `<w:tblPr><w:tblBorders>` +
      `<w:top w:val="single" w:sz="4" w:color="auto"/><w:left w:val="single" w:sz="4" w:color="auto"/>` +
      `<w:bottom w:val="single" w:sz="4" w:color="auto"/><w:right w:val="single" w:sz="4" w:color="auto"/>` +
      `<w:insideH w:val="single" w:sz="4" w:color="auto"/><w:insideV w:val="single" w:sz="4" w:color="auto"/>` +
      `</w:tblBorders></w:tblPr></w:style>`;
    const tbl =
      `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/></w:tblPr><w:tblGrid><w:gridCol/></w:tblGrid>` +
      `<w:tr><w:tc><w:p><w:r><w:t>셀</w:t></w:r></w:p></w:tc></w:tr></w:tbl>`;
    const body = renderPreviewBody(makeParts({ docBody: tbl, styles }), DEFAULT_PALETTE).body;
    expect(body).toContain("docloom-table-bordered");
    expect(body).toMatch(/border-top:0\.5pt solid #000/); // sz 4/8 = 0.5pt, auto → #000
  });

  it("테두리 정보가 없는 표는 회색 기본 테두리(클래스 미부여)를 유지한다", () => {
    const tbl =
      `<w:tbl><w:tblGrid><w:gridCol/></w:tblGrid>` +
      `<w:tr><w:tc><w:p><w:r><w:t>셀</w:t></w:r></w:p></w:tc></w:tr></w:tbl>`;
    const body = renderPreviewBody(makeParts({ docBody: tbl }), DEFAULT_PALETTE).body;
    expect(body).not.toContain("docloom-table-bordered");
  });
});
