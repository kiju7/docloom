/**
 * rtf 어댑터 — 구조 보존 + 텍스트 런 패치 왕복 검증.
 * 핵심 불변식: 무편집 = 바이트 동일. 텍스트만 바꾸면 그 런만 재인코딩, 나머지 전부 보존.
 * 한글은 코드페이지(\ansicpg949 / \fcharset129)의 \'XX 헥스를 정확히 디코드해야 한다.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { adapterFor, encode, decode } from "../src/index.js";
import { isRtf, formatFromFilename } from "../src/core/detect.js";
import { rtfEncode, rtfDecode } from "../src/formats/rtf.js";

const te = new TextEncoder();
const b = (s: string) => te.encode(s);
function plain(html: string): string {
  return html.replace(/<[^>]+>/g, "").replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}

const ASCII_RTF = `{\\rtf1\\ansi\\deff0
{\\fonttbl{\\f0 Times New Roman;}}
\\pard\\f0\\fs24
{\\b Bold Title}\\par
Plain body line.\\par
{\\i italic} and {\\b bold} mixed.\\par
}`;

// macOS Cocoa RTF: \ansicpg949 + \fcharset129(한글) + \'XX(EUC-KR/CP949) 헥스.
// "기술" = b1 e2 bc fa, "특성" = c6 af bc ba, "보안" = ba b8 be c8.
// 두 문단(\par 로 분리)이라 각각 별도 런 → 한쪽 편집해도 다른 한글 보존 검증 가능.
const KO_RTF = `{\\rtf1\\ansi\\ansicpg949\\cocoartf2867
{\\fonttbl\\f0\\fswiss\\fcharset0 Helvetica;\\f1\\fnil\\fcharset129 AppleSDGothicNeo;}
{\\colortbl;\\red255\\green255\\blue255;}
\\pard\\f0\\fs24 AI \\f1 \\'b1\\'e2\\'bc\\'fa\\f0  \\f1 \\'c6\\'af\\'bc\\'ba\\par
\\f1 \\'ba\\'b8\\'be\\'c8\\par
}`;

describe("rtf 판별", () => {
  it("매직 {\\rtf 와 확장자", () => {
    expect(isRtf(b(ASCII_RTF))).toBe(true);
    expect(isRtf(b("not rtf"))).toBe(false);
    expect(isRtf(b("﻿" + ASCII_RTF))).toBe(true); // BOM 허용
    expect(formatFromFilename("a.rtf")).toBe("rtf");
    expect(adapterFor(b(ASCII_RTF)).id).toBe("rtf");
  });
});

describe("rtf 왕복(구조 보존 + 런 패치)", () => {
  it("무편집 왕복은 바이트 동일", () => {
    const bytes = b(ASCII_RTF);
    const { html, manifest } = rtfEncode(bytes);
    const out = rtfDecode(html, manifest);
    expect(Array.from(out)).toEqual(Array.from(bytes));
  });

  it("ASCII 본문 디코드 + 굵게/기울임 마크업", () => {
    const { html } = rtfEncode(b(ASCII_RTF));
    expect(plain(html)).toContain("Bold Title");
    expect(plain(html)).toContain("Plain body line.");
    expect(html).toContain("<strong>");
    expect(html).toContain("<em>");
    expect(html).toMatch(/data-rid="r\d+"/);
  });

  it("한글 \\'XX 헥스를 CP949 로 정확히 디코드", () => {
    const { html } = rtfEncode(b(KO_RTF));
    expect(plain(html)).toContain("기술");
    expect(plain(html)).toContain("특성");
    expect(plain(html)).toContain("보안");
  });

  it("한 런 텍스트 편집 → 그 런만 바뀌고 나머지 보존", () => {
    const bytes = b(ASCII_RTF);
    const { html, manifest } = rtfEncode(bytes);
    // "Plain body line." 런을 찾아 편집.
    const m = html.match(/(<span data-rid="r\d+">)(Plain body line\.)(<\/span>)/);
    expect(m).toBeTruthy();
    const edited = html.replace(m![0], `${m![1]}Plain body line CHANGED.${m![3]}`);
    const out = rtfDecode(edited, manifest);
    // 복원물 재추출: 편집 반영 + 다른 런(Bold Title/italic/bold) 보존.
    const re = rtfEncode(out);
    const t = plain(re.html);
    expect(t).toContain("Plain body line CHANGED.");
    expect(t).toContain("Bold Title");
    expect(t).toContain("italic");
    // 복원물은 다시 유효한 rtf.
    expect(isRtf(out)).toBe(true);
  });

  it("한글 런 편집 후에도 다른 한글 보존", () => {
    const bytes = b(KO_RTF);
    const { html, manifest } = rtfEncode(bytes);
    // 첫 문단 런 = "AI 기술 특성"(폰트변경은 런을 안 쪼갬). 그 안의 기술→신기술.
    const m = html.match(/(<span data-rid="r\d+">)([^<]*기술[^<]*)(<\/span>)/);
    expect(m).toBeTruthy();
    const edited = html.replace(m![0], `${m![1]}${m![2].replace("기술", "신기술")}${m![3]}`);
    const out = rtfDecode(edited, manifest);
    const t = plain(rtfEncode(out).html);
    expect(t).toContain("신기술");
    expect(t).toContain("보안"); // 둘째 문단(안 건드린 한글) 보존
  });

  it("제네릭 encode/decode 경로(자동판별)", () => {
    const bytes = b(ASCII_RTF);
    const enc = encode(bytes);
    expect(enc.manifest.format).toBe("rtf");
    const out = decode(enc.html, enc.manifest);
    expect(Array.from(out)).toEqual(Array.from(bytes));
  });
});

// 실파일이 있으면 추가 검증(없으면 스킵).
const REAL = "/Users/jd-kimkiju/Desktop/test_sample/rtf/개인정보및민감정보기획.rtf";
describe.runIf(existsSync(REAL))("rtf 실파일", () => {
  it("macOS 한글 RTF: 무편집 바이트동일 + 한글 추출", () => {
    const bytes = new Uint8Array(readFileSync(REAL));
    const { html, manifest } = rtfEncode(bytes);
    expect(plain(html)).toContain("가명"); // 본문 한글
    const out = rtfDecode(html, manifest);
    expect(Array.from(out)).toEqual(Array.from(bytes));
  });
});
