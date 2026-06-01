import { describe, it, expect } from "vitest";
import { pptAdapter, pptToPreviewHtml } from "../src/formats/ppt.js";
import { writeCfb, buildCfbModel } from "../src/core/cfb.js";

// ── PPT 레코드 빌더 ──────────────────────────────────────────────────────────

/** 레코드 헤더(8B) + body. verInst 하위 4bit 0xF 면 컨테이너. */
function rec(verInst: number, recType: number, body: number[]): number[] {
  const len = body.length;
  return [
    verInst & 0xff, (verInst >> 8) & 0xff,
    recType & 0xff, (recType >> 8) & 0xff,
    len & 0xff, (len >> 8) & 0xff, (len >> 16) & 0xff, (len >> 24) & 0xff,
    ...body,
  ];
}

/** TextCharsAtom(0x0FA0): UTF-16LE. */
function textChars(s: string): number[] {
  const body: number[] = [];
  for (const c of s) {
    const code = c.charCodeAt(0);
    body.push(code & 0xff, (code >> 8) & 0xff);
  }
  return rec(0x0000, 0x0fa0, body);
}

/** TextBytesAtom(0x0FA8): ANSI 1B. */
function textBytes(s: string): number[] {
  return rec(0x0000, 0x0fa8, [...s].map((c) => c.charCodeAt(0) & 0xff));
}

/** Slide 컨테이너(0x03EE) — 자식 레코드를 품는다(verInst 하위 4bit=0xF). */
function slide(children: number[]): number[] {
  return rec(0x000f, 0x03ee, children);
}

describe("ppt 어댑터 계약", () => {
  it("이제 왕복(encode/decode)을 지원한다(길이 보존 편집 기준)", () => {
    expect(pptAdapter.supportsRoundTrip).toBe(true);
    expect(typeof pptAdapter.encode).toBe("function");
    expect(typeof pptAdapter.decode).toBe("function");
  });
  it("detect 는 false(컨테이너 라우팅)", () => {
    expect(pptAdapter.detect({})).toBe(false);
  });
});

describe("ppt 레코드 파싱(구성한 PowerPoint Document 스트림)", () => {
  function buildPpt(): Uint8Array {
    const doc = [
      ...slide([...textChars("첫 슬라이드 제목"), ...textBytes("Bullet one")]),
      ...slide([...textChars("두번째 슬라이드"), ...textBytes("Second body")]),
    ];
    return writeCfb(buildCfbModel({ "PowerPoint Document": new Uint8Array(doc) }));
  }

  it("슬라이드별로 TextChars/TextBytes 텍스트를 추출한다", () => {
    const html = pptToPreviewHtml(buildPpt());
    expect(html).toContain("첫 슬라이드 제목");
    expect(html).toContain("Bullet one");
    expect(html).toContain("두번째 슬라이드");
    expect(html).toContain("Second body");
    expect(html).toContain("슬라이드 1");
    expect(html).toContain("슬라이드 2");
  });

  it("스트림이 없으면 안내 문구를 보인다", () => {
    const empty = writeCfb(buildCfbModel({ Other: new Uint8Array([1, 2, 3]) }));
    const html = pptToPreviewHtml(empty);
    expect(html).toContain("PowerPoint Document");
  });

  it("어댑터 toPreviewHtml 경로도 동작한다", () => {
    const html = pptAdapter.toPreviewHtml(buildPpt(), {});
    expect(html).toContain("ppt-slide");
  });
});
