/**
 * styles.xml CSS 추출 — 문단 테두리(제목 밑줄)·음영 보강 검증.
 */
import { describe, it, expect } from "vitest";
import { extractStyleCss } from "../src/index.js";
import type { Palette } from "../src/palette/palette.js";

const palette: Palette = {
  id: "t",
  fallbackStyleKey: "body",
  entries: [
    { styleKey: "title", docxStyleId: "Title", htmlTag: "h1" },
    { styleKey: "body", docxStyleId: "Normal", htmlTag: "p" },
  ],
};

const styles = `<?xml version="1.0"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/>
  <w:pPr><w:pBdr><w:bottom w:val="single" w:sz="12" w:color="4472C4"/></w:pBdr><w:shd w:fill="EFEFEF"/></w:pPr>
  <w:rPr><w:sz w:val="56"/></w:rPr>
</w:style>
</w:styles>`;

describe("문단 테두리·음영 CSS 추출", () => {
  it("제목 스타일의 아래 테두리(밑줄)를 CSS 로 추출한다", () => {
    const css = extractStyleCss(styles, palette);
    expect(css).toMatch(/\.s-title\s*\{[^}]*border-bottom:[^;]*solid #4472C4/);
    expect(css).toMatch(/\.s-title\s*\{[^}]*padding-bottom:4pt/);
  });

  it("문단 음영(shd fill)을 배경색으로 추출한다", () => {
    const css = extractStyleCss(styles, palette);
    expect(css).toMatch(/\.s-title\s*\{[^}]*background-color:#EFEFEF/);
  });

  it("테두리 없는 본문 스타일엔 border 가 붙지 않는다", () => {
    const css = extractStyleCss(styles, palette);
    const bodyRule = /\.s-body\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(bodyRule).not.toMatch(/border-/);
  });
});
