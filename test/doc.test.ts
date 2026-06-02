import { describe, it, expect } from "vitest";
import { docAdapter, docToPreviewHtml } from "../src/formats/doc.js";
import { writeCfb, buildCfbModel, readCfb } from "../src/core/cfb.js";
import { parseTableDef } from "../src/formats/doc-format.js";

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

describe("doc 표 테두리(셀 brc 없이 표 수준 테두리만)", () => {
  // 셀별 TC80 brc 가 전부 0(none)이고, 격자선은 sprmTTableBorders80(0xD613)에만
  // 들어있는 표 — Word 가 흔히 쓰는 저장 방식. 이 경우 격자선이 사라지면 안 된다.
  /** Brc80 4B: [dptLineWidth][brcType][ico][flags]. */
  const brc = (w: number, t = 1, ico = 0) => [w, t, ico, 0];

  function buildRowGrpprl(itcMac: number, edgesTwips?: number[]): Uint8Array {
    // sprmTDefTable(0xD608): [cb:2][itcMac:1][rgdxaCenter:(itcMac+1)*2][rgTc80:itcMac*20]
    const e = edgesTwips ?? new Array(itcMac + 1).fill(0);
    const rgdxa: number[] = [];
    for (const v of e) rgdxa.push(v & 0xff, (v >> 8) & 0xff); // int16 LE
    const rgtc = new Array(itcMac * 20).fill(0); // 셀별 brc 전부 0 = none
    const defBody = [itcMac, ...rgdxa, ...rgtc];
    const cb = defBody.length + 1; // operandLen(0xD608) = 2 + (cb-1)
    const defOperand = [cb & 0xff, (cb >> 8) & 0xff, ...defBody];
    // sprmTTableBorders80(0xD613): [cb=24][top,left,bottom,right,insideH,insideV]
    const tbOperand = [24, ...brc(8), ...brc(8), ...brc(8), ...brc(8), ...brc(4), ...brc(4)];
    return new Uint8Array([0x08, 0xd6, ...defOperand, 0x13, 0xd6, ...tbOperand]);
  }

  it("셀 brc 가 없어도 표 수준 테두리(insideH/insideV 포함)를 파싱한다", () => {
    const def = parseTableDef(buildRowGrpprl(2));
    expect(def).not.toBeNull();
    expect(def!.itcMac).toBe(2);
    // 셀별 brc 는 비어있다(none).
    expect(def!.cells[0]!.top).toBeUndefined();
    expect(def!.cells[0]!.left).toBeUndefined();
    // 표 수준 테두리에서 격자선(insideH/insideV)이 복원된다.
    expect(def!.tableBorders).toBeDefined();
    expect(def!.tableBorders!.insideH?.style).toBe("solid");
    expect(def!.tableBorders!.insideV?.style).toBe("solid");
    expect(def!.tableBorders!.top?.style).toBe("solid");
    expect(def!.tableBorders!.insideH?.widthPt).toBeCloseTo(0.5);
    expect(def!.tableBorders!.top?.widthPt).toBeCloseTo(1);
  });

  it("rgdxaCenter(셀 경계 좌표)를 edges 로 파싱한다", () => {
    const def = parseTableDef(buildRowGrpprl(6, [0, 1845, 3833, 4938, 6069, 7496, 9637]));
    expect(def!.edges).toEqual([0, 1845, 3833, 4938, 6069, 7496, 9637]);
  });
});

describe("doc 표 정렬(행마다 열 경계가 달라도 좌표로 맞춤)", () => {
  // sample.doc 안에는 'Item' 셀 아래 들여쓴 하위 행(7칸)이 헤더(6칸)와 섞인 표가 있다.
  // 좌표 기반 통합 그리드가 없으면 하위 행이 한 칸씩 밀려 오른쪽으로 삐져나간다.
  it("중첩 들여쓰기 행이 헤더 열과 정렬된다(colgroup + 선행 colspan)", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const path = fileURLToPath(new URL("./fixtures/sample.doc", import.meta.url));
    const bytes = new Uint8Array(readFileSync(path));
    const html = docToPreviewHtml(bytes);
    const tables = html.match(/<table[\s\S]*?<\/table>/g) ?? [];
    const t = tables.find((x) => x.includes("locdate"));
    expect(t).toBeDefined();
    // 통합 그리드 → <colgroup> 으로 열 폭 고정.
    expect(t!).toContain("<colgroup>");
    // 6칸 행의 선행 셀이 좁은 들여쓰기 열을 흡수 → colspan 으로 정렬.
    expect(t!).toMatch(/colspan="2"/);
  });
});
