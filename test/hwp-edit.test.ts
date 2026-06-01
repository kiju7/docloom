import { describe, it, expect } from "vitest";
import { writeZip, readZip, partToText } from "../src/core/zip.js";
import { buildCfbModel, writeCfb, readCfb } from "../src/core/cfb.js";
import {
  serializeRecords,
  hwpInflate,
  hwpDeflate,
  stringToWchars,
  parseRecords,
  wcharsToString,
  type HwpRecord,
} from "../src/hwp/record.js";
import { encodeHwpToHtml } from "../src/encode/hwpToHtml.js";
import { decodeHtmlToHwp } from "../src/decode/hwpToHwp.js";
import { encodeHwpxToHtml } from "../src/encode/hwpxToHtml.js";
import { decodeHtmlToHwpx } from "../src/decode/htmlToHwpx.js";

const te = new TextEncoder();

// ── HWP 합성 픽스처 ─────────────────────────────────────────────────────────
function rec(tag: number, level: number, data: Uint8Array): HwpRecord {
  return { tag, level, data };
}
function paraHeader(nChars: number, styleId: number): Uint8Array {
  const d = new Uint8Array(22);
  const dv = new DataView(d.buffer);
  dv.setUint32(0, nChars, true);
  dv.setUint8(10, styleId);
  dv.setUint16(12, 1, true);
  return d;
}
function makeHwp(): Uint8Array {
  const fh = new Uint8Array(256);
  fh.set(te.encode("HWP Document File"), 0);
  new DataView(fh.buffer).setUint32(36, 0x01, true);

  const styleData = (name: string) => {
    const d = new Uint8Array(2 + name.length * 2 + 10);
    const dv = new DataView(d.buffer);
    dv.setUint16(0, name.length, true);
    for (let i = 0; i < name.length; i++) dv.setUint16(2 + i * 2, name.charCodeAt(i), true);
    return d;
  };
  const docInfo = serializeRecords([
    rec(26, 0, styleData("바탕글")),
    rec(26, 0, styleData("개요 1")),
    rec(21, 0, new Uint8Array(72)),
  ]);
  const cs = new Uint8Array(8);
  const section0 = serializeRecords([
    rec(66, 0, paraHeader(2, 1)),
    rec(67, 1, stringToWchars("제목")),
    rec(68, 1, cs),
    rec(66, 0, paraHeader(8, 0)),
    rec(67, 1, stringToWchars("안녕하세요 한글")),
    rec(68, 1, cs),
    rec(66, 0, paraHeader(0, 0)),
    rec(71, 1, te.encode("tbl ")), // 컨트롤 → frozen
  ]);
  return writeCfb(
    buildCfbModel({ FileHeader: fh, DocInfo: hwpDeflate(docInfo), "BodyText/Section0": hwpDeflate(section0) }),
  );
}
function hwpSectionTexts(hwp: Uint8Array): string[] {
  const cfb = readCfb(hwp);
  return parseRecords(hwpInflate(cfb.streams["BodyText/Section0"]!))
    .filter((r) => r.tag === 67)
    .map((r) => wcharsToString(r.data).replace(/[\r\n]+$/, ""))
    .filter((t) => t.length > 0);
}

/** 한 문단에 글자모양이 둘 섞인 .hwp — 0~2글자=csId5, 3~끝=csId7. */
function makeHwpMultiCharShape(): Uint8Array {
  const fh = new Uint8Array(256);
  fh.set(te.encode("HWP Document File"), 0);
  new DataView(fh.buffer).setUint32(36, 0x01, true);
  const styleData = (name: string) => {
    const d = new Uint8Array(2 + name.length * 2 + 10);
    const dv = new DataView(d.buffer);
    dv.setUint16(0, name.length, true);
    for (let i = 0; i < name.length; i++) dv.setUint16(2 + i * 2, name.charCodeAt(i), true);
    return d;
  };
  const docInfo = serializeRecords([rec(26, 0, styleData("바탕글")), rec(21, 0, new Uint8Array(72))]);
  const charShape = (pairs: Array<[number, number]>) => {
    const d = new Uint8Array(pairs.length * 8);
    const dv = new DataView(d.buffer);
    pairs.forEach(([p, id], i) => {
      dv.setUint32(i * 8, p, true);
      dv.setUint32(i * 8 + 4, id, true);
    });
    return d;
  };
  const text = "가나다라마"; // 5글자 + \r = nChars 6
  const ph = paraHeader(text.length + 1, 0);
  new DataView(ph.buffer).setUint16(12, 2, true); // charShapeCount = 2
  const section0 = serializeRecords([
    rec(66, 0, ph),
    rec(67, 1, stringToWchars(text + "\r")),
    rec(68, 1, charShape([[0, 5], [3, 7]])),
  ]);
  return writeCfb(
    buildCfbModel({ FileHeader: fh, DocInfo: hwpDeflate(docInfo), "BodyText/Section0": hwpDeflate(section0) }),
  );
}
function hwpParaCharShape(hwp: Uint8Array): Array<[number, number]> {
  const recs = parseRecords(hwpInflate(readCfb(hwp).streams["BodyText/Section0"]!));
  const cs = recs.find((r) => r.tag === 68)!;
  const dv = new DataView(cs.data.buffer, cs.data.byteOffset, cs.data.byteLength);
  const out: Array<[number, number]> = [];
  for (let i = 0; i + 8 <= cs.data.length; i += 8) out.push([dv.getUint32(i, true), dv.getUint32(i + 4, true)]);
  return out;
}

// ── HWPX 합성 픽스처 ────────────────────────────────────────────────────────
const HX_HEADER = `<?xml version="1.0"?><hh:head xmlns:hh="h"><hh:refList>` +
  `<hh:charProperties><hh:charPr id="0" height="1000"/></hh:charProperties>` +
  `<hh:styles><hh:style id="0" type="PARA" name="바탕글" charPrIDRef="0"/></hh:styles></hh:refList></hh:head>`;
const HX_SECTION = `<?xml version="1.0"?><hs:sec xmlns:hs="s" xmlns:hp="p">` +
  `<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>첫 문단</hp:t></hp:run></hp:p>` +
  `<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>둘째 문단</hp:t></hp:run></hp:p></hs:sec>`;
function makeHwpx(): Uint8Array {
  return writeZip({
    mimetype: te.encode("application/hwp+zip"),
    "Contents/header.xml": te.encode(HX_HEADER),
    "Contents/section0.xml": te.encode(HX_SECTION),
  });
}
function hwpxSectionXml(hwpx: Uint8Array): string {
  return partToText(readZip(hwpx), "Contents/section0.xml");
}

// ── 테스트 ──────────────────────────────────────────────────────────────────
describe("HWP 문단 추가/삭제 (풀 편집)", () => {
  it("문단 추가가 .hwp 에 반영된다", () => {
    const first = encodeHwpToHtml(makeHwp());
    // 컨트롤 문단(div.s-frozen) 앞에 새 문단 삽입
    const added = first.html.replace(
      /(<div class="s-frozen")/,
      `<p class="s-body">새로 추가한 문단</p>\n$1`,
    );
    const out = decodeHtmlToHwp(added, first.manifest);
    const texts = hwpSectionTexts(out);
    expect(texts).toContain("새로 추가한 문단");
    expect(texts).toContain("제목");
    expect(texts).toContain("안녕하세요 한글");
  });

  it("문단 삭제가 .hwp 에 반영된다", () => {
    const first = encodeHwpToHtml(makeHwp());
    const removed = first.html.replace(/<p class="s-body"[^>]*>안녕하세요 한글<\/p>\n?/, "");
    const out = decodeHtmlToHwp(removed, first.manifest);
    const texts = hwpSectionTexts(out);
    expect(texts).not.toContain("안녕하세요 한글");
    expect(texts).toContain("제목"); // 다른 문단·컨트롤 보존
  });

  it("추가/삭제 후에도 컨트롤(frozen) 문단이 보존된다", () => {
    const first = encodeHwpToHtml(makeHwp());
    const out = decodeHtmlToHwp(first.html, first.manifest);
    const recs = parseRecords(hwpInflate(readCfb(out).streams["BodyText/Section0"]!));
    expect(recs.some((r) => r.tag === 71)).toBe(true); // CTRL_HEADER 보존
  });
});

describe("HWP 다중 글자모양 문단 편집 (서식 섞인 문단도 편집 가능)", () => {
  it("한 문단에 글자모양이 섞여도 frozen 이 아니라 런별로 편집 가능하다", () => {
    const { html, manifest, model } = encodeHwpToHtml(makeHwpMultiCharShape());
    const para = model.blocks.find((b: any) => b.runs)!;
    expect((para as any).runs.length).toBe(2); // 글자모양 경계로 2런
    // 각 런이 자기 charShapeId 토큰(propsRef)을 갖는다
    expect(manifest.props[(para as any).runs[0].propsRef]).toBe("5");
    expect(manifest.props[(para as any).runs[1].propsRef]).toBe("7");
    expect(html).toMatch(/<span data-rp="[^"]+">가나다<\/span><span data-rp="[^"]+">라마<\/span>/);
  });

  it("런 텍스트를 고쳐도 글자모양 경계(PARA_CHAR_SHAPE)가 재구성·보존된다", () => {
    const { html, manifest } = encodeHwpToHtml(makeHwpMultiCharShape());
    const edited = html.replace("라마", "라마바사"); // 둘째 런만 길어짐
    const out = decodeHtmlToHwp(edited, manifest);
    expect(hwpSectionTexts(out)).toContain("가나다라마바사");
    // 글자모양 2개·둘째 경계 pos=3(가나다 뒤) 유지, 둘째 런 csId 7 그대로
    expect(hwpParaCharShape(out)).toEqual([[0, 5], [3, 7]]);
  });

  it("앞 런을 고치면 뒤 런 경계가 그만큼 밀린다", () => {
    const { html, manifest } = encodeHwpToHtml(makeHwpMultiCharShape());
    const edited = html.replace("가나다", "가나다AB"); // 첫 런 +2
    const out = decodeHtmlToHwp(edited, manifest);
    expect(hwpSectionTexts(out)).toContain("가나다AB라마");
    expect(hwpParaCharShape(out)).toEqual([[0, 5], [5, 7]]); // 경계 3→5
  });
});

describe("HWPX 문단 추가/삭제", () => {
  it("새 문단이 유효한 hp:p(styleIDRef·charPrIDRef)로 추가된다", () => {
    const first = encodeHwpxToHtml(makeHwpx());
    const added = first.html.replace("</div>", `<p class="s-body">추가 문단</p></div>`);
    const out = decodeHtmlToHwpx(added, first.manifest);
    const xml = hwpxSectionXml(out);
    expect(xml).toContain("추가 문단");
    expect(xml).toContain('styleIDRef="0"');
    expect(xml).toContain('charPrIDRef="0"');
    expect(xml).toContain("첫 문단");
    expect(xml).toContain("둘째 문단");
  });

  it("문단 삭제가 hwpx 에 반영된다", () => {
    const first = encodeHwpxToHtml(makeHwpx());
    const removed = first.html.replace(/<p\b[^>]*>(?:(?!<\/p>)[\s\S])*둘째 문단(?:(?!<\/p>)[\s\S])*<\/p>/, "");
    const out = decodeHtmlToHwpx(removed, first.manifest);
    const xml = hwpxSectionXml(out);
    expect(xml).not.toContain("둘째 문단");
    expect(xml).toContain("첫 문단");
  });
});
