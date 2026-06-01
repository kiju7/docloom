import { describe, it, expect } from "vitest";
import { writeZip, readZip, partToText } from "../src/core/zip.js";
import { encodeHwpxToHtml } from "../src/encode/hwpxToHtml.js";
import { decodeHtmlToHwpx } from "../src/decode/htmlToHwpx.js";
import { isHwpx } from "../src/core/detect.js";

const te = new TextEncoder();

const HEADER = `<?xml version="1.0" encoding="UTF-8"?>
<hh:head xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head">
  <hh:refList>
    <hh:charProperties itemCnt="2">
      <hh:charPr id="0" height="1000" textColor="#000000"/>
      <hh:charPr id="1" height="1600" textColor="#FF0000"><hh:bold/></hh:charPr>
    </hh:charProperties>
    <hh:paraProperties itemCnt="1">
      <hh:paraPr id="0"><hh:align horizontal="LEFT"/></hh:paraPr>
    </hh:paraProperties>
    <hh:styles itemCnt="2">
      <hh:style id="0" type="PARA" name="바탕글" paraPrIDRef="0" charPrIDRef="0"/>
      <hh:style id="1" type="PARA" name="개요 1" paraPrIDRef="0" charPrIDRef="1"/>
    </hh:styles>
  </hh:refList>
</hh:head>`;

const SECTION0 = `<?xml version="1.0" encoding="UTF-8"?>
<hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph">
  <hp:p paraPrIDRef="0" styleIDRef="1" id="1"><hp:run charPrIDRef="1"><hp:t>제목입니다</hp:t></hp:run></hp:p>
  <hp:p paraPrIDRef="0" styleIDRef="0" id="2"><hp:run charPrIDRef="0"><hp:t>안녕하세요 한글</hp:t></hp:run></hp:p>
  <hp:p paraPrIDRef="0" styleIDRef="0" id="3"><hp:run charPrIDRef="0"><hp:tbl><hp:tr><hp:tc><hp:t>셀</hp:t></hp:tc></hp:tr></hp:tbl></hp:run></hp:p>
</hs:sec>`;

function makeHwpx(): Uint8Array {
  return writeZip({
    mimetype: te.encode("application/hwp+zip"),
    "Contents/header.xml": te.encode(HEADER),
    "Contents/section0.xml": te.encode(SECTION0),
    "META-INF/container.xml": te.encode("<container/>"),
  });
}

describe("hwpx ↔ html 왕복", () => {
  it("HWPX 시그니처를 판별한다", () => {
    const parts = readZip(makeHwpx());
    expect(isHwpx(parts)).toBe(true);
  });

  it("encode 가 스타일 class·굵게·표 frozen 을 보존한다", () => {
    const { html, model, manifest } = encodeHwpxToHtml(makeHwpx());
    expect(html).toContain('class="s-heading1"');
    expect(html).toContain('class="s-body"');
    expect(html).toContain("제목입니다");
    expect(html).toContain("안녕하세요 한글");
    expect(html).toContain("<strong>"); // charPr id=1 → bold
    expect(html).toContain('data-frozen'); // 표는 frozen

    expect(manifest.format).toBe("hwpx");
    expect(manifest.container).toBe("zip");

    // 제목/본문/표문단 3개 블록
    expect(model.blocks).toHaveLength(3);
    expect(model.blocks[0]).toMatchObject({ type: "heading", styleKey: "heading1" });
    expect(model.blocks[1]).toMatchObject({ type: "paragraph", styleKey: "body" });
  });

  it("hwpx → html → hwpx 왕복 후 모델이 동일하다", () => {
    const first = encodeHwpxToHtml(makeHwpx());
    const rebuilt = decodeHtmlToHwpx(first.html, first.manifest);
    const second = encodeHwpxToHtml(rebuilt);
    expect(second.model).toEqual(first.model);
  });

  it("왕복 후에도 표(frozen)·구역 원본이 보존된다", () => {
    const first = encodeHwpxToHtml(makeHwpx());
    const rebuilt = decodeHtmlToHwpx(first.html, first.manifest);
    const sectionXml = partToText(readZip(rebuilt), "Contents/section0.xml");
    expect(sectionXml).toContain("hp:tbl");
    expect(sectionXml).toContain("셀");
    // header·mimetype 등 원본 파트는 그대로
    const parts = readZip(rebuilt);
    expect(partToText(parts, "mimetype")).toBe("application/hwp+zip");
    expect(partToText(parts, "Contents/header.xml")).toBe(HEADER);
  });

  it("본문 텍스트를 편집하면 hwpx 에 반영된다", () => {
    const first = encodeHwpxToHtml(makeHwpx());
    const edited = first.html.replace("안녕하세요 한글", "수정된 본문");
    const rebuilt = decodeHtmlToHwpx(edited, first.manifest);
    const sectionXml = partToText(readZip(rebuilt), "Contents/section0.xml");
    expect(sectionXml).toContain("수정된 본문");
    expect(sectionXml).not.toContain("안녕하세요 한글");
  });
});
