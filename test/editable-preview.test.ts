import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parse } from "node-html-parser";
import { editablePreviewHtml, decode, encode } from "../src/index.js";

const te = new TextEncoder();

describe("미리보기에서 바로 편집 (editablePreviewHtml)", () => {
  it("docx: 스타일+contenteditable 페이지 → 편집 → 복원 왕복", () => {
    const bytes = new Uint8Array(readFileSync("test/fixtures/sample.docx"));
    const { html, manifest, format } = editablePreviewHtml(bytes, { title: "t" });
    expect(format).toBe("docx");
    expect(html).toContain('id="dl-edit"');
    expect(html).toContain('contenteditable="true"');
    expect(html).toContain("docloom-doc"); // 미리보기 스타일 클래스

    // #dl-edit 안의 한 단어를 편집하고 decode
    const el = parse(html).querySelector("#dl-edit")!;
    let inner = el.innerHTML;
    const m = inner.match(/>([^<>]{3,})</);
    expect(m).toBeTruthy();
    const edited = inner.replace(m![0], ">편집됨" + m![1].slice(2) + "<");
    const out = decode(edited, manifest, { format });
    expect(out[0]).toBe(0x50); // PK (zip)
    expect(out[1]).toBe(0x4b);
    // 재인코딩 시 편집 내용이 살아있다
    expect(encode(out).html).toContain("편집됨");
  });

  it("csv: 셀 편집 → 복원에 반영", () => {
    const { html, manifest, format } = editablePreviewHtml(te.encode("a,b\n1,2\n"), {});
    expect(format).toBe("csv");
    const el = parse(html).querySelector("#dl-edit")!;
    const edited = el.innerHTML.replace(">1<", ">99<");
    const out = decode(edited, manifest, { format });
    expect(new TextDecoder().decode(out)).toContain("99");
  });

  it("미리보기 전용 포맷(pdf)은 명확히 거부", () => {
    expect(() => editablePreviewHtml(te.encode("%PDF-1.4\n"))).toThrow();
  });
});
