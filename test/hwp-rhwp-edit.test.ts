import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  hwpToEditableHtml,
  applyHwpEdits,
  hwpToRichPreviewHtml,
  hwpToHybridPreviewHtml,
} from "../src/rhwp/hwpEdit.js";
import { loadRhwp, rhwpDir, type HwpDocCtor } from "../scripts/rhwpNode.js";

// rhwp WASM 을 Node 에서 초기화해 실제 HwpDocument 로 편집 채널을 검증한다.
// 로더는 vendor/rhwp(소스 빌드) → node_modules/@rhwp/core(stock) 순으로 산출물을 찾는다.
const here = dirname(fileURLToPath(import.meta.url));
const HWP = join(here, "fixtures", "sample.hwp");
const ready = rhwpDir() != null && existsSync(HWP);

let HwpDocument: HwpDocCtor;

beforeAll(async () => {
  if (!ready) return;
  HwpDocument = (await loadRhwp())!;
});

describe.runIf(ready)("rhwp 기반 HWP 편집 채널 (표 셀 포함)", () => {
  it("편집 HTML 에 표 셀 텍스트가 앵커와 함께 노출된다", () => {
    const doc = new HwpDocument(new Uint8Array(readFileSync(HWP)));
    const html = hwpToEditableHtml(doc);
    expect(html).toContain('data-hwp-edit="1"');
    expect(html).toMatch(/data-hc="\d+,\d+,\d+,\d+,\d+"/); // 표 셀 앵커
    expect(html).toContain("<table"); // 표 구조 보존
    // 셀/평문 텍스트가 실제로 들어있다(빈 문서가 아님)
    const textLen = html.replace(/<[^>]+>/g, "").replace(/\s+/g, "").length;
    expect(textLen).toBeGreaterThan(100);
  });

  it("셀 텍스트를 고치면 exportHwpx 후에도 반영되고 다른 셀은 보존된다", () => {
    const doc = new HwpDocument(new Uint8Array(readFileSync(HWP)));
    const html = hwpToEditableHtml(doc);

    // 첫 번째 비어있지 않은 셀을 찾아 텍스트를 바꾼다. (셀 div 는 미리보기 스타일 속성을 가질 수 있다.)
    const m = html.match(/<div data-hc="([^"]+)"[^>]*>([^<]+)<\/div>/);
    expect(m).toBeTruthy();
    const original = m![2];
    const marker = original + "★EDIT";
    const edited = html.replace(`>${original}</div>`, `>${marker}</div>`);
    expect(edited).not.toBe(html);

    const n = applyHwpEdits(doc, edited);
    expect(n).toBeGreaterThanOrEqual(1);

    const out = doc.exportHwpx();
    expect(out.length).toBeGreaterThan(0);

    // 재로드 → 편집 반영 확인
    const doc2 = new HwpDocument(out);
    const html2 = hwpToEditableHtml(doc2);
    expect(html2).toContain("★EDIT");
  });

  it("편집이 없으면 0건을 적용한다(멱등)", () => {
    const doc = new HwpDocument(new Uint8Array(readFileSync(HWP)));
    const html = hwpToEditableHtml(doc);
    expect(applyHwpEdits(doc, html)).toBe(0);
  });

  it("리치 미리보기에 표·셀텍스트·셀배경이 흐름배치로 렌더된다", () => {
    const doc = new HwpDocument(new Uint8Array(readFileSync(HWP)));
    const html = hwpToRichPreviewHtml(doc, { title: "sample" });
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain('class="hp-page"'); // 흐름배치 종이 컨테이너
    expect(html).toContain("<table"); // 표 구조
    // 표 셀 텍스트가 실제로 들어있다(SVG 가 놓치던 내용 포함)
    const textLen = html.replace(/<style[\s\S]*?<\/style>/, "").replace(/<[^>]+>/g, "").replace(/\s+/g, "").length;
    expect(textLen).toBeGreaterThan(100);
    // 셀 배경(fillColor) 이 하나라도 칠해진다 (sample.hwp 에 컬러 셀 존재)
    expect(html).toMatch(/<td[^>]*background:#[0-9a-f]{6}/i);
  });

  it("하이브리드 미리보기는 rhwp SVG 페이지를 렌더한다(주경로)", () => {
    const doc = new HwpDocument(new Uint8Array(readFileSync(HWP)));
    const html = hwpToHybridPreviewHtml(doc, { title: "sample" });
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain('class="rhwp-page"'); // SVG 페이지(픽셀 충실 주경로)
    expect(html).toContain("<svg"); // 실제 SVG 렌더
    // 누락 표가 없으면 보충 섹션은 없다(있어도 정상 — 데이터에 따라)
    if (!html.includes("hp-supp")) expect(html).not.toContain("놓친 표");
  });
});
