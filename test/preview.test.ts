import { describe, it, expect } from "vitest";
import { docxToPreviewHtml, extractStyleCss, DEFAULT_PALETTE } from "../src/index.js";
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
