import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { hwpxToPreviewHtml } from "../src/formats/hwpx.js";
import { hwpToPreviewHtml } from "../src/formats/hwp.js";
import { encodeHwpxToHtml } from "../src/encode/hwpxToHtml.js";
import { decodeHtmlToHwpx } from "../src/decode/htmlToHwpx.js";
import { encodeHwpToHtml } from "../src/encode/hwpToHtml.js";
import { decodeHtmlToHwp } from "../src/decode/hwpToHwp.js";
import { readZip, partToText } from "../src/core/zip.js";

const here = dirname(fileURLToPath(import.meta.url));
const HWPX = join(here, "fixtures", "sample.hwpx");
const HWP = join(here, "fixtures", "sample.hwp");
const hasHwpx = existsSync(HWPX);
const hasHwp = existsSync(HWP);
const load = (p: string) => new Uint8Array(readFileSync(p));

describe("실제 한글 파일 미리보기/왕복", () => {
  it.runIf(hasHwpx)("실 .hwpx 미리보기에 본문 텍스트와 표가 렌더된다", () => {
    const html = hwpxToPreviewHtml(load(HWPX));
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<table"); // 표 렌더
    expect(html).toContain("성능지표"); // 실제 본문 텍스트
    expect(html).toContain("font-size:"); // 글자 크기 반영
    expect(html).toContain("text-align:"); // 정렬 반영
    expect(html).toMatch(/border-(left|top):\d/); // 표 테두리 반영
    expect(html).toContain('id="dl-pages"'); // 페이지 레이아웃
    expect(html.length).toBeGreaterThan(3000);
  });

  it.runIf(hasHwpx)("실 .hwpx 본문 편집이 왕복된다", () => {
    const { html, manifest } = encodeHwpxToHtml(load(HWPX));
    expect(html).toContain("성능지표");
    const edited = html.replace("성능지표", "성능지표(수정)");
    const out = decodeHtmlToHwpx(edited, manifest);
    const xml = partToText(readZip(out), "Contents/section0.xml");
    expect(xml).toContain("성능지표(수정)");
    // 원본 파트 보존
    expect(readZip(out)["Contents/header.xml"]).toBeTruthy();
  });

  it.runIf(hasHwp)("실 .hwp 미리보기에 본문 텍스트와 표가 렌더된다", () => {
    const html = hwpToPreviewHtml(load(HWP));
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<table");
    expect(html).toContain("성능"); // 실제 본문 텍스트
    expect(html).toContain("font-size:"); // 글자 크기 반영
    expect(html).toContain("text-align:"); // 정렬 반영
    expect(html).toContain('id="dl-pages"'); // 페이지 레이아웃
    expect(html).toContain("<img"); // 그림(BinData) 렌더
    expect(html.length).toBeGreaterThan(3000);
  });

  it.runIf(hasHwp)("실 .hwp 가 encode/decode 후에도 다시 열린다(구조 유지)", () => {
    const { html, manifest, model } = encodeHwpToHtml(load(HWP));
    // 실제 문서엔 텍스트 문단이 다수 존재
    const textChars = model.blocks
      .filter((b: any) => b.runs)
      .reduce((s: number, b: any) => s + b.runs.map((r: any) => r.text ?? "").join("").length, 0);
    expect(textChars).toBeGreaterThan(200);

    // 편집 없이 왕복 → 다시 encode 가능(레코드/CFB 유효)
    const out = decodeHtmlToHwp(html, manifest);
    const round = encodeHwpToHtml(out);
    expect(round.model.blocks.length).toBeGreaterThan(0);
  });

  // 실파일 편집 왕복: CFB 라이터 + LINE_SEG 드롭 + patchParaHeader 가
  // 실제 한글 .hwp 에서 동작함을 회귀로 고정(합성테스트만으론 부족했던 항목).
  const firstTextRun = (model: any) => {
    for (const b of model.blocks) {
      if (!b.runs) continue;
      const t = b.runs.map((r: any) => r.text ?? "").join("");
      if (t.trim().length > 4 && /[가-힣]/.test(t)) return t;
    }
    return null;
  };
  const hasText = (model: any, needle: string) =>
    model.blocks.some(
      (b: any) =>
        b.runs && b.runs.map((r: any) => r.text ?? "").join("").includes(needle),
    );

  it.runIf(hasHwp)("실 .hwp 본문 텍스트 편집이 왕복된다", () => {
    const { html, manifest, model } = encodeHwpToHtml(load(HWP));
    const orig = firstTextRun(model);
    expect(orig).toBeTruthy();
    const edited = html.replace(orig!, orig! + "[수정]");
    expect(edited).not.toBe(html);

    const out = decodeHtmlToHwp(edited, manifest);
    const round = encodeHwpToHtml(out);
    expect(hasText(round.model, "[수정]")).toBe(true); // 편집 텍스트 생존
    expect(round.model.blocks.length).toBe(model.blocks.length); // 문단 수 유지
  });

  it.runIf(hasHwp)("실 .hwp 문단 추가/삭제가 왕복된다", () => {
    const { html, manifest, model } = encodeHwpToHtml(load(HWP));
    const base = model.blocks.length;
    const firstP = html.match(/<p\b[^>]*>.*?<\/p>/s);
    expect(firstP).toBeTruthy();

    // 추가: 첫 문단 뒤에 신규 문단 삽입 → 블록 수 증가 + 텍스트 생존
    const added = html.replace(firstP![0], firstP![0] + "<p>신규문단(ADD)</p>");
    const roundAdd = encodeHwpToHtml(decodeHtmlToHwp(added, manifest));
    expect(roundAdd.model.blocks.length).toBe(base + 1);
    expect(hasText(roundAdd.model, "신규문단")).toBe(true);

    // 삭제: 첫 문단 제거 → 블록 수 감소
    const removed = html.replace(firstP![0], "");
    const roundDel = encodeHwpToHtml(decodeHtmlToHwp(removed, manifest));
    expect(roundDel.model.blocks.length).toBe(base - 1);
  });
});
