import { describe, it, expect } from "vitest";
import { buildCfbModel, writeCfb, readCfb } from "../src/core/cfb.js";
import {
  serializeRecords,
  hwpInflate,
  hwpDeflate,
  stringToWchars,
  parseRecords,
  wcharsToString,
  HWPTAG_PARA_HEADER,
  HWPTAG_PARA_TEXT,
  HWPTAG_PARA_CHAR_SHAPE,
  HWPTAG_CTRL_HEADER,
  HWPTAG_STYLE,
  HWPTAG_CHAR_SHAPE,
  type HwpRecord,
} from "../src/hwp/record.js";
import { encodeHwpToHtml } from "../src/encode/hwpToHtml.js";
import { decodeHtmlToHwp } from "../src/decode/hwpToHwp.js";

// ── 합성 .hwp 빌더 ──────────────────────────────────────────────────────────

function fileHeader(): Uint8Array {
  const fh = new Uint8Array(256);
  fh.set(new TextEncoder().encode("HWP Document File"), 0);
  const dv = new DataView(fh.buffer);
  dv.setUint32(32, 0x05050000, true); // version 5.0.5.0
  dv.setUint32(36, 0x01, true); // props: compressed
  return fh;
}

function styleRecord(name: string): HwpRecord {
  const data = new Uint8Array(2 + name.length * 2 + 2 + 1 + 1 + 2 + 2 + 2);
  const dv = new DataView(data.buffer);
  dv.setUint16(0, name.length, true);
  for (let i = 0; i < name.length; i++) dv.setUint16(2 + i * 2, name.charCodeAt(i), true);
  return { tag: HWPTAG_STYLE, level: 0, data };
}

function charShapeRecord(prop: number): HwpRecord {
  const data = new Uint8Array(72);
  new DataView(data.buffer).setUint32(46, prop, true);
  return { tag: HWPTAG_CHAR_SHAPE, level: 0, data };
}

function paraHeader(nChars: number, styleId: number, charShapeCount: number): HwpRecord {
  const data = new Uint8Array(22);
  const dv = new DataView(data.buffer);
  dv.setUint32(0, nChars, true);
  dv.setUint8(10, styleId);
  dv.setUint16(12, charShapeCount, true);
  return { tag: HWPTAG_PARA_HEADER, level: 0, data };
}

function paraText(text: string): HwpRecord {
  return { tag: HWPTAG_PARA_TEXT, level: 1, data: stringToWchars(text) };
}

function paraCharShape(charShapeId: number): HwpRecord {
  const data = new Uint8Array(8);
  new DataView(data.buffer).setUint32(4, charShapeId, true);
  return { tag: HWPTAG_PARA_CHAR_SHAPE, level: 1, data };
}

function ctrlHeader(): HwpRecord {
  return { tag: HWPTAG_CTRL_HEADER, level: 1, data: new Uint8Array([0x74, 0x62, 0x6c, 0x20]) }; // "tbl "
}

function makeHwp(): Uint8Array {
  const docInfo = serializeRecords([
    styleRecord("바탕글"),
    styleRecord("개요 1"),
    charShapeRecord(0x00), // id0: 서식 없음
    charShapeRecord(0x02), // id1: 굵게(bit1)
  ]);

  const section0 = serializeRecords([
    paraHeader(2, 1, 1),
    paraText("제목"),
    paraCharShape(1), // 굵게
    paraHeader(8, 0, 1),
    paraText("안녕하세요 한글"),
    paraCharShape(0),
    // 컨트롤 포함 문단 → frozen
    paraHeader(0, 0, 1),
    ctrlHeader(),
  ]);

  return writeCfb(
    buildCfbModel({
      FileHeader: fileHeader(),
      DocInfo: hwpDeflate(docInfo),
      "BodyText/Section0": hwpDeflate(section0),
    }),
  );
}

function section0Text(hwp: Uint8Array): string {
  const cfb = readCfb(hwp);
  const decompressed = hwpInflate(cfb.streams["BodyText/Section0"]!);
  return parseRecords(decompressed)
    .filter((r) => r.tag === HWPTAG_PARA_TEXT)
    .map((r) => wcharsToString(r.data))
    .join("|");
}

// ── 테스트 ──────────────────────────────────────────────────────────────────

describe("hwp ↔ html 왕복", () => {
  it("encode 가 스타일·굵게·컨트롤 frozen 을 보존한다", () => {
    const { html, model, manifest } = encodeHwpToHtml(makeHwp());
    expect(html).toContain('class="s-heading1"');
    expect(html).toContain('class="s-body"');
    expect(html).toContain("제목");
    expect(html).toContain("안녕하세요 한글");
    expect(html).toContain("<strong>"); // charShape id1 → bold
    expect(html).toContain("data-frozen"); // 컨트롤 문단

    expect(manifest.format).toBe("hwp");
    expect(manifest.container).toBe("cfb");

    expect(model.blocks).toHaveLength(3);
    expect(model.blocks[0]).toMatchObject({ type: "heading", styleKey: "heading1" });
    expect(model.blocks[1]).toMatchObject({ type: "paragraph", styleKey: "body" });
    expect(model.blocks[2]).toMatchObject({ type: "frozen" });
  });

  it("hwp → html → hwp 왕복 후 모델이 동일하다", () => {
    const first = encodeHwpToHtml(makeHwp());
    const rebuilt = decodeHtmlToHwp(first.html, first.manifest);
    const second = encodeHwpToHtml(rebuilt);
    expect(second.model).toEqual(first.model);
  });

  it("본문 텍스트 편집이 hwp 에 반영되고 나머지는 보존된다", () => {
    const first = encodeHwpToHtml(makeHwp());
    const edited = first.html.replace("안녕하세요 한글", "수정된 본문입니다");
    const rebuilt = decodeHtmlToHwp(edited, first.manifest);

    const text = section0Text(rebuilt);
    expect(text).toContain("수정된 본문입니다");
    expect(text).toContain("제목"); // 다른 문단 보존
    expect(text).not.toContain("안녕하세요 한글");

    // 재encode 해도 편집 내용이 살아있다
    const re = encodeHwpToHtml(rebuilt);
    expect(re.html).toContain("수정된 본문입니다");
  });
});
