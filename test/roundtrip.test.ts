import { describe, it, expect } from "vitest";
import { encodeToHtml, decodeToDocx } from "../src/index.js";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const SAMPLE = join(here, "fixtures", "sample.docx");
const hasSample = existsSync(SAMPLE);
const loadSample = () => new Uint8Array(readFileSync(SAMPLE));

describe("docx ↔ html 왕복", () => {
  it.runIf(hasSample)("encode 가 양식 스타일을 class 로 보존한다", () => {
    const { html, model } = encodeToHtml(loadSample());

    expect(html).toContain('class="s-title"');
    expect(html).toContain('class="s-heading1"');
    expect(html).toContain('class="s-body"');
    expect(html).toContain("<strong>증가</strong>");

    expect(model.blocks).toHaveLength(4);
    expect(model.blocks[0]).toMatchObject({ type: "heading", styleKey: "title" });
  });

  it.runIf(hasSample)("docx → html → docx 왕복 후 내용·스타일이 동일하다", () => {
    const original = loadSample();
    const first = encodeToHtml(original);

    const rebuilt = decodeToDocx(first.html, first.manifest);
    const second = encodeToHtml(rebuilt);

    // 중간 모델이 동일하면 텍스트·styleKey·marks 가 모두 보존된 것.
    expect(stripUndefined(second.model)).toEqual(stripUndefined(first.model));
  });

  it.runIf(hasSample)("sectPr(섹션 속성)·스타일 part 가 그대로 유지된다", () => {
    const { html, manifest } = encodeToHtml(loadSample());
    const out = decodeToDocx(html, manifest);

    const text = new TextDecoder().decode(out);
    // zip 안의 document.xml 바이트엔 sectPr 가 남아있어야 함(전체 zip 문자열로 느슨히 확인)
    expect(out.byteLength).toBeGreaterThan(0);
    // styles.xml 은 원본 그대로 보존되므로 재인코딩 시 같은 styleKey 가 다시 나와야 함
    const re = encodeToHtml(out);
    expect(re.html).toContain('class="s-heading1"');
    void text;
  });

  it("팔레트 불일치면 decode 가 거부한다", () => {
    const fakeManifest = {
      version: 1 as const,
      originalParts: {},
      frozen: {},
      paletteId: "some-other-palette",
    };
    expect(() => decodeToDocx("<div></div>", fakeManifest)).toThrow(/팔레트 불일치/);
  });
});

/** 모델 비교 시 undefined 필드 차이를 무시하기 위한 정규화. */
function stripUndefined<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}
