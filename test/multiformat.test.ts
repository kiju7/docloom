/**
 * 멀티포맷 디스패치 — 포맷 자동판별 + pptx/xlsx 미리보기 + 왕복 미구현 가드.
 */
import { describe, it, expect } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { previewHtml, encode, decode, adapterFor } from "../src/index.js";
import { detectOoxml } from "../src/core/detect.js";
import { readZip } from "../src/core/zip.js";

function pptx(): Uint8Array {
  return zipSync({
    "[Content_Types].xml": strToU8(`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>`),
    "ppt/presentation.xml": strToU8(`<p:presentation xmlns:p="x"/>`),
    "ppt/slides/slide1.xml": strToU8(`<p:sld xmlns:p="x" xmlns:a="y"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>안녕 슬라이드</a:t></a:r></a:p><a:p><a:r><a:t>두 번째 줄</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`),
  });
}

function xlsx(): Uint8Array {
  return zipSync({
    "[Content_Types].xml": strToU8(`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>`),
    "xl/workbook.xml": strToU8(`<workbook xmlns="x"><sheets><sheet name="매출"/></sheets></workbook>`),
    "xl/sharedStrings.xml": strToU8(`<sst xmlns="x"><si><t>이름</t></si><si><t>금액</t></si></sst>`),
    "xl/worksheets/sheet1.xml": strToU8(`<worksheet xmlns="x"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2"><v>100</v></c><c r="B2"><v>200</v></c></row></sheetData></worksheet>`),
  });
}

describe("포맷 자동판별", () => {
  it("content-types/디렉터리로 pptx·xlsx 를 판별한다", () => {
    expect(detectOoxml(readZip(pptx()))).toBe("pptx");
    expect(detectOoxml(readZip(xlsx()))).toBe("xlsx");
  });
  it("adapterFor 가 올바른 어댑터를 고른다", () => {
    expect(adapterFor(pptx()).id).toBe("pptx");
    expect(adapterFor(xlsx()).id).toBe("xlsx");
  });
});

describe("pptx 미리보기", () => {
  it("슬라이드 텍스트를 추출해 HTML 로 그린다", () => {
    const html = previewHtml(pptx());
    expect(html).toMatch(/^<!DOCTYPE html>/);
    expect(html).toContain("안녕 슬라이드");
    expect(html).toContain("두 번째 줄");
    expect(html).toContain("pptx-slide");
  });
});

describe("xlsx 미리보기", () => {
  it("시트를 표로 그리고 sharedStrings 를 해석한다", () => {
    const html = previewHtml(xlsx());
    expect(html).toContain("매출"); // 시트 이름
    expect(html).toContain("이름"); // sharedStrings[0]
    expect(html).toContain("금액"); // sharedStrings[1]
    expect(html).toContain("100"); // 숫자 셀
  });
});

describe("왕복 지원", () => {
  it("pptx 도 이제 왕복(encode)을 지원한다 — html + manifest 반환", () => {
    const { html, manifest } = encode(pptx());
    expect(html).toContain("안녕 슬라이드");
    expect(manifest.format).toBe("pptx");
    expect(Object.keys(manifest.originalParts).length).toBeGreaterThan(0);
  });
  it("xlsx 도 왕복(encode)을 지원한다", () => {
    const { manifest } = encode(xlsx());
    expect(manifest.format).toBe("xlsx");
  });
});
