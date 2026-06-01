import { describe, it, expect } from "vitest";
import { adapterFor, encode, decode, previewHtml } from "../src/index.js";
import { writeZip, readZip, partToText } from "../src/core/zip.js";
import { buildCfbModel, writeCfb } from "../src/core/cfb.js";
import { serializeRecords, hwpDeflate, stringToWchars } from "../src/hwp/record.js";

const te = new TextEncoder();

function makeHwpx(): Uint8Array {
  const header = `<?xml version="1.0"?><hh:head xmlns:hh="h"><hh:refList><hh:styles>` +
    `<hh:style id="0" type="PARA" name="바탕글" charPrIDRef="0"/></hh:styles>` +
    `<hh:charProperties><hh:charPr id="0" height="1000"/></hh:charProperties></hh:refList></hh:head>`;
  const section = `<?xml version="1.0"?><hs:sec xmlns:hs="s" xmlns:hp="p">` +
    `<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>제네릭 한글</hp:t></hp:run></hp:p></hs:sec>`;
  return writeZip({
    mimetype: te.encode("application/hwp+zip"),
    "Contents/header.xml": te.encode(header),
    "Contents/section0.xml": te.encode(section),
  });
}

function makeHwp(): Uint8Array {
  const fh = new Uint8Array(256);
  fh.set(te.encode("HWP Document File"), 0);
  new DataView(fh.buffer).setUint32(36, 0x01, true); // compressed

  const styleData = new Uint8Array(12);
  new DataView(styleData.buffer).setUint16(0, 3, true);
  for (let i = 0; i < 3; i++) new DataView(styleData.buffer).setUint16(2 + i * 2, "바탕글".charCodeAt(i), true);
  const docInfo = serializeRecords([{ tag: 26, level: 0, data: styleData }, { tag: 21, level: 0, data: new Uint8Array(72) }]);

  const ph = new Uint8Array(22);
  new DataView(ph.buffer).setUint32(0, "제네릭 한글".length, true);
  new DataView(ph.buffer).setUint16(12, 1, true);
  const cs = new Uint8Array(8);
  const section = serializeRecords([
    { tag: 66, level: 0, data: ph },
    { tag: 67, level: 1, data: stringToWchars("제네릭 한글") },
    { tag: 68, level: 1, data: cs },
  ]);

  return writeCfb(buildCfbModel({ FileHeader: fh, DocInfo: hwpDeflate(docInfo), "BodyText/Section0": hwpDeflate(section) }));
}

describe("아래한글 자동판별 + 제네릭 API", () => {
  it("adapterFor 가 .hwpx 를 hwpx 어댑터로 라우팅한다", () => {
    expect(adapterFor(makeHwpx()).id).toBe("hwpx");
  });

  it("adapterFor 가 .hwp(CFB) 를 hwp 어댑터로 라우팅한다", () => {
    expect(adapterFor(makeHwp()).id).toBe("hwp");
  });

  it("제네릭 encode/decode 가 hwpx 를 왕복한다(manifest.format 으로 디스패치)", () => {
    const { html, manifest } = encode(makeHwpx());
    expect(manifest.format).toBe("hwpx");
    const out = decode(html.replace("제네릭 한글", "수정됨"), manifest);
    expect(partToText(readZip(out), "Contents/section0.xml")).toContain("수정됨");
  });

  it("제네릭 previewHtml 이 hwpx/hwp 미리보기를 만든다", () => {
    expect(previewHtml(makeHwpx())).toContain("<!DOCTYPE html>");
    expect(previewHtml(makeHwp())).toContain("제네릭 한글");
  });
});
