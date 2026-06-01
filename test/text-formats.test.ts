import { describe, it, expect } from "vitest";
import { detectTextSubtype, formatFromFilename } from "../src/core/detect.js";
import { adapterFor, encode, decode } from "../src/index.js";
import { txtEncode, txtDecode } from "../src/formats/txt.js";
import { htmlEncode, htmlDecode } from "../src/formats/html.js";
import { mdEncode, mdDecode, mdToHtml, htmlToMd } from "../src/formats/md.js";

const te = new TextEncoder();
// ignoreBOM: 선행 BOM 을 벗기지 않아야 왕복 바이트 비교가 정확하다.
const td = new TextDecoder("utf-8", { ignoreBOM: true });
const b = (s: string) => te.encode(s);
const s = (u: Uint8Array) => td.decode(u);

describe("평문 하위포맷 판별", () => {
  it("확장자 → 포맷", () => {
    expect(formatFromFilename("a.html")).toBe("html");
    expect(formatFromFilename("a.HTM")).toBe("html");
    expect(formatFromFilename("readme.md")).toBe("md");
    expect(formatFromFilename("notes.txt")).toBe("txt");
    expect(formatFromFilename("data.csv")).toBe("csv");
    expect(formatFromFilename("x.docx")).toBe("docx");
    expect(formatFromFilename("noext")).toBeUndefined();
  });

  it("내용 추정 — html/md/csv/txt", () => {
    expect(detectTextSubtype(b("<!DOCTYPE html><html><body>hi</body></html>"))).toBe("html");
    expect(detectTextSubtype(b("<div class=x>hi</div>"))).toBe("html");
    expect(detectTextSubtype(b("# 제목\n\n본문 **굵게**"))).toBe("md");
    expect(detectTextSubtype(b("- a\n- b\n- c"))).toBe("md");
    expect(detectTextSubtype(b("name,age\nAlice,30\nBob,25"))).toBe("csv");
    expect(detectTextSubtype(b("그냥 평범한 메모입니다.\n둘째 줄."))).toBe("txt");
    // 쉼표 섞인 산문은 csv 로 오인하지 않는다(열 수 불일치).
    expect(detectTextSubtype(b("안녕, 반가워\n오늘은 날씨가 좋고, 바람도 적당하고, 맑다"))).toBe("txt");
  });

  it("adapterFor 가 힌트로 정확히 라우팅", () => {
    // 마크다운처럼 보여도 .txt 힌트면 txt 로.
    expect(adapterFor(b("- a\n- b"), "txt").id).toBe("txt");
    // 힌트 없으면 내용 추정.
    expect(adapterFor(b("- a\n- b")).id).toBe("md");
    expect(adapterFor(b("a,b\n1,2")).id).toBe("csv");
  });
});

describe("txt 왕복 1급", () => {
  for (const [i, src] of [
    "첫 줄\n둘째 줄\n셋째 줄\n",
    "trailing 없음\n마지막 줄",
    "빈 줄 포함\n\n사이가 비었다\n",
    "﻿BOM 있는 파일\r\nCRLF 줄끝\r\n",
    "  앞 공백   과   중간   공백 보존  ",
  ].entries()) {
    it(`source #${i} 줄/줄끝/BOM 보존`, () => {
      const bytes = b(src);
      const { html, manifest } = txtEncode(bytes);
      const out = txtDecode(html, manifest);
      // 바이트 동일(BOM·CRLF 포함).
      expect(s(out)).toBe(src);
    });
  }
});

describe("html 왕복 — 셸 보존 + 본문만 교체", () => {
  it("head/doctype 보존, body 교체", () => {
    const src = `<!DOCTYPE html><html lang="ko"><head><title>T</title><style>p{color:red}</style></head><body><p>안녕</p></body></html>`;
    const { html, manifest } = htmlEncode(b(src));
    expect(html).toBe("<p>안녕</p>");
    // 본문 편집
    const edited = "<p>수정됨</p><p>추가</p>";
    const out = s(htmlDecode(edited, manifest));
    expect(out).toContain("<title>T</title>");
    expect(out).toContain("<style>p{color:red}</style>");
    expect(out).toContain("<p>수정됨</p><p>추가</p>");
    expect(out).not.toContain("안녕");
  });

  it("조각(fragment)은 그대로 왕복", () => {
    const src = "<p>just a fragment</p>";
    const { html, manifest } = htmlEncode(b(src));
    expect(s(htmlDecode(html, manifest))).toBe(src);
  });

  it("제네릭 경로 — adapterFor 판별", () => {
    const bytes = b("<html><body><h1>Hi</h1></body></html>");
    expect(adapterFor(bytes).id).toBe("html");
  });
});

describe("md 변환 — 핵심 블록/인라인", () => {
  it("mdToHtml 블록", () => {
    const html = mdToHtml(
      ["# 제목", "", "본문 **굵게** *기울임* `코드`.", "", "- 하나", "- 둘", "", "> 인용문", "", "```js", "const x=1;", "```"].join("\n"),
    );
    expect(html).toContain("<h1>제목</h1>");
    expect(html).toContain("<strong>굵게</strong>");
    expect(html).toContain("<em>기울임</em>");
    expect(html).toContain("<code>코드</code>");
    expect(html).toContain("<ul><li>하나</li><li>둘</li></ul>");
    expect(html).toContain("<blockquote>");
    expect(html).toContain('<pre><code class="language-js">const x=1;</code></pre>');
  });

  it("GFM 표", () => {
    const html = mdToHtml(["| A | B |", "| --- | ---: |", "| 1 | 2 |"].join("\n"));
    expect(html).toContain("md-table");
    expect(html).toContain("<th>A</th>");
    expect(html).toContain('style="text-align:right"');
    expect(html).toContain("<td>1</td>");
  });

  it("htmlToMd 역변환", () => {
    const md = htmlToMd("<h2>제목</h2><p>본문 <strong>굵게</strong> <a href=\"http://x\">링크</a></p><ul><li>a</li><li>b</li></ul>");
    expect(md).toContain("## 제목");
    expect(md).toContain("**굵게**");
    expect(md).toContain("[링크](http://x)");
    expect(md).toContain("- a");
    expect(md).toContain("- b");
  });

  it("내용 보존 왕복 (md → html → md)", () => {
    const src = ["# Title", "", "Para with **bold** and `code`.", "", "- item 1", "- item 2", "", "## Sub", "", "More text."].join("\n");
    const { html, manifest } = mdEncode(b(src));
    const out = s(mdDecode(html, manifest));
    expect(out).toContain("# Title");
    expect(out).toContain("**bold**");
    expect(out).toContain("`code`");
    expect(out).toContain("- item 1");
    expect(out).toContain("- item 2");
    expect(out).toContain("## Sub");
    expect(out).toContain("More text.");
  });

  it("제네릭 encode/decode — manifest.format=md", () => {
    const bytes = b("# Hi\n\nbody");
    const { html, manifest } = encode(bytes);
    expect(manifest.format).toBe("md");
    const out = s(decode(html, manifest));
    expect(out).toContain("# Hi");
    expect(out).toContain("body");
  });
});
