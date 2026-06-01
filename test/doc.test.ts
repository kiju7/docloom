import { describe, it, expect } from "vitest";
import { docAdapter, docToPreviewHtml } from "../src/formats/doc.js";
import { writeCfb, buildCfbModel, readCfb } from "../src/core/cfb.js";

// ── 최소 .doc(Word 97-2003) CFB 빌더 ─────────────────────────────────────────
//
// WordDocument: FIB(선두) + raw 텍스트. 1Table: CLX(piece table).
// 한 개의 비압축(UTF-16LE) piece 로 알려진 텍스트를 담는다.

const TEXT_FC = 0x200; // WordDocument 내 텍스트 시작 오프셋(FIB 헤더 뒤, 단순화).

/** 비압축 UTF-16LE 한 piece 짜리 .doc 를 만든다. */
function buildDoc(text: string): Uint8Array {
  // 1) WordDocument: FIB(최소 0x1AA 바이트) + 텍스트.
  const utf16 = new Uint8Array(text.length * 2);
  {
    const dv = new DataView(utf16.buffer);
    for (let i = 0; i < text.length; i++) dv.setUint16(i * 2, text.charCodeAt(i), true);
  }
  const wd = new Uint8Array(TEXT_FC + utf16.length);
  const wdv = new DataView(wd.buffer);
  wdv.setUint16(0x0000, 0xa5ec, true); // wIdent
  wdv.setUint16(0x0002, 0x00c1, true); // nFib(193 = Word 97)
  // flags @ 0x000A: fWhichTblStm 비트(0x0200) 켜기 → "1Table".
  wdv.setUint16(0x000a, 0x0200, true);
  wdv.setInt32(0x0018, TEXT_FC, true); // fcMin
  wdv.setInt32(0x001c, TEXT_FC + utf16.length, true); // fcMac
  wd.set(utf16, TEXT_FC);

  // 2) 1Table: CLX = Pcdt(0x02) [lcb u32] [PlcPcd]. (RgPrc 없음)
  //    PlcPcd: CP[0]=0, CP[1]=text.length, 그 뒤 1개 PCD(8B).
  //    PCD: +0 u16 flags, +2 fc(u32), +6 u16 prm. 비압축이므로 fc = 실제오프셋(TEXT_FC).
  const n = 1;
  const lcb = (n + 1) * 4 + n * 8; // 12n+4 = 16
  const clx: number[] = [];
  clx.push(0x02);
  clx.push(lcb & 0xff, (lcb >> 8) & 0xff, (lcb >> 16) & 0xff, (lcb >> 24) & 0xff);
  // CP 배열
  const pushU32 = (v: number) => clx.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff);
  pushU32(0); // CP[0]
  pushU32(text.length); // CP[1]
  // PCD: flags(0), fc(=TEXT_FC, 비압축이므로 0x40000000 비트 없음), prm(0)
  clx.push(0, 0); // flags u16
  pushU32(TEXT_FC); // fc u32 (비압축)
  clx.push(0, 0); // prm u16

  const fcClx = 0; // CLX 가 Table 스트림 맨 앞.
  const lcbClx = clx.length;
  // FibRgFcLcb97: fcClx @ 0x01A2, lcbClx @ 0x01A6.
  wdv.setUint32(0x01a2, fcClx, true);
  wdv.setUint32(0x01a6, lcbClx, true);

  return writeCfb(
    buildCfbModel({
      WordDocument: wd,
      "1Table": new Uint8Array(clx),
      Data: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
    }),
  );
}

describe("doc 어댑터 계약", () => {
  it("왕복(encode/decode)을 지원한다(길이 보존 편집 기준)", () => {
    expect(docAdapter.supportsRoundTrip).toBe(true);
    expect(typeof docAdapter.encode).toBe("function");
    expect(typeof docAdapter.decode).toBe("function");
  });
  it("detect 는 false(컨테이너 라우팅)", () => {
    expect(docAdapter.detect({})).toBe(false);
  });
});

describe("doc 미리보기(FIB + CLX piece table 파싱)", () => {
  it("비압축 piece 의 텍스트를 추출해 보여준다", () => {
    const doc = buildDoc("첫째 문단\r둘째 문단\r");
    const html = docToPreviewHtml(doc);
    expect(html).toContain("첫째 문단");
    expect(html).toContain("둘째 문단");
  });

  it("CR(0x0D)로 문단을 나눠 <p> 로 렌더한다", () => {
    const doc = buildDoc("Alpha\rBeta\rGamma\r");
    const html = docToPreviewHtml(doc);
    // 리치 렌더러는 서식 입은 <p style="…"> 로 문단을 낸다.
    const pCount = (html.match(/<p[\s>]/g) ?? []).length;
    expect(pCount).toBe(3);
    expect(html).toContain("Alpha");
    expect(html).toContain("Beta");
    expect(html).toContain("Gamma");
  });

  it("WordDocument 스트림이 없으면 안내 문구를 보인다", () => {
    const empty = writeCfb(buildCfbModel({ Other: new Uint8Array([1, 2, 3]) }));
    const html = docToPreviewHtml(empty);
    expect(html).toContain("해석하지 못했습니다");
  });

  it("어댑터 toPreviewHtml 경로도 동작한다", () => {
    const doc = buildDoc("Hello\r");
    const html = docAdapter.toPreviewHtml(doc, {});
    expect(html).toContain("Hello");
  });

  it("Table 스트림 선택(fWhichTblStm)이 1Table 을 가리킨다", () => {
    const doc = buildDoc("X\r");
    const cfb = readCfb(doc);
    expect(cfb.streams["1Table"]).toBeDefined();
  });
});
