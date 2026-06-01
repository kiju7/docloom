import { describe, it, expect } from "vitest";
import { validateHtml, encodeToHtml, decodeToDocx, DEFAULT_PALETTE } from "../src/index.js";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const SAMPLE = join(here, "fixtures", "sample.docx");
const hasSample = existsSync(SAMPLE);
const loadSample = () => new Uint8Array(readFileSync(SAMPLE));
const P = DEFAULT_PALETTE;

describe("validator — 지저분한 HTML 정규화", () => {
  it("인라인 style 과 script 를 제거하고 텍스트는 보존한다", () => {
    const { html, report } = validateHtml(
      `<div class="docloom-doc"><p class="s-body" style="color:red">안녕<script>alert(1)</script>하세요</p></div>`,
      P,
    );
    expect(html).not.toContain("style=");
    expect(html).not.toContain("script");
    expect(html).toContain("안녕하세요");
    expect(report.strippedInlineStyles).toBeGreaterThanOrEqual(1);
    expect(report.removedTags).toContain("script");
  });

  it("모르는 class 는 fallback(body)으로 재매핑된다", () => {
    const { html, report } = validateHtml(
      `<div class="docloom-doc"><p class="s-madeup">텍스트</p></div>`,
      P,
    );
    expect(html).toContain('class="s-body"');
    expect(html).not.toContain("s-madeup");
    expect(report.remappedClasses).toContain("s-madeup");
  });

  it("b→strong, i→em 별칭을 정규화한다", () => {
    const { html } = validateHtml(
      `<div class="docloom-doc"><p class="s-body"><b>굵게</b> <i>기울임</i></p></div>`,
      P,
    );
    expect(html).toContain("<strong>굵게</strong>");
    expect(html).toContain("<em>기울임</em>");
    expect(html).not.toMatch(/<b>|<i>/);
  });

  it("ul/ol 을 풀어 li 를 블록으로 끌어올린다", () => {
    const { html } = validateHtml(
      `<div class="docloom-doc"><ul><li class="s-listItem">하나</li><li class="s-listItem">둘</li></ul></div>`,
      P,
    );
    expect(html).not.toContain("<ul>");
    expect(html.match(/<li /g) ?? []).toHaveLength(2);
  });

  it("class 가 없으면 태그(h2)로 styleKey 를 추론한다", () => {
    const { html } = validateHtml(`<div class="docloom-doc"><h2>소제목</h2></div>`, P);
    expect(html).toContain('class="s-heading2"');
  });

  it("닫히지 않은 태그도 관용적으로 처리한다", () => {
    const { html } = validateHtml(`<p class="s-body">깨진 <strong>볼드 텍스트`, P);
    expect(html).toContain("docloom-doc");
    expect(html).toContain("볼드 텍스트");
  });

  it.runIf(hasSample)("지저분한 편집 HTML 도 끝까지 docx 로 복원된다", () => {
    const { manifest } = encodeToHtml(loadSample());

    const dirty = `
      <div class="docloom-doc">
        <h1 class="s-title" style="text-align:left">분기 보고서 (수정본)</h1>
        <h1 class="s-heading1">요약</h1>
        <p class="s-body">매출이 <b>크게 증가</b>했습니다.<script>steal()</script></p>
        <section><p class="s-foo">새 문단</p></section>
      </div>`;

    const out = decodeToDocx(dirty, manifest);
    const re = encodeToHtml(out);

    const texts = re.model.blocks
      .filter((b): b is Extract<typeof b, { runs: unknown }> => "runs" in b)
      .map((b) => b.runs.map((r) => r.text).join(""));

    expect(texts).toContain("분기 보고서 (수정본)");
    expect(texts).toContain("매출이 크게 증가했습니다.");
    expect(texts).toContain("새 문단");
    // script 내용은 사라져야 함
    expect(re.html).not.toContain("steal");
    // 굵게가 보존됐는지
    expect(re.html).toContain("<strong>크게 증가</strong>");
    // 모르는 s-foo 는 body 로
    expect(re.html).not.toContain("s-foo");
  });
});
