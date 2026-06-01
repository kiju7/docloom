import { describe, it, expect } from "vitest";
import { writeCfb, buildCfbModel, readCfb } from "../src/core/cfb.js";
import { encodeXlsToHtml } from "../src/encode/xlsToHtml.js";
import { decodeHtmlToXls } from "../src/decode/htmlToXls.js";
import { xlsToPreviewHtml } from "../src/formats/xls.js";
import { parseWorkbook } from "../src/formats/xls-biff.js";

// ── BIFF8 Workbook 빌더(test/xls.test.ts 의 구성을 재사용) ─────────────────────

class Buf {
  private parts: number[] = [];
  u8(v: number): this { this.parts.push(v & 0xff); return this; }
  u16(v: number): this { this.parts.push(v & 0xff, (v >> 8) & 0xff); return this; }
  u32(v: number): this { this.parts.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff); return this; }
  f64(v: number): this {
    const dv = new DataView(new ArrayBuffer(8));
    dv.setFloat64(0, v, true);
    for (let i = 0; i < 8; i++) this.parts.push(dv.getUint8(i));
    return this;
  }
  bytes(arr: number[]): this { for (const b of arr) this.parts.push(b & 0xff); return this; }
  get array(): number[] { return this.parts; }
  get length(): number { return this.parts.length; }
}

function rec(type: number, data: number[]): number[] {
  return [type & 0xff, (type >> 8) & 0xff, data.length & 0xff, (data.length >> 8) & 0xff, ...data];
}

function shortStr8(s: string): number[] {
  return [0x00, ...[...s].map((c) => c.charCodeAt(0))];
}

/** patch a 4B LE value at offset into a flat byte array. */
function patchU32(arr: number[], at: number, v: number): void {
  arr[at] = v & 0xff;
  arr[at + 1] = (v >> 8) & 0xff;
  arr[at + 2] = (v >> 16) & 0xff;
  arr[at + 3] = (v >> 24) & 0xff;
}

const XF_INDEX = 42; // 비-0 XF index → 스타일 보존 검증용

function buildWorkbook(): Uint8Array {
  // SST: total=2, unique=2 → "Hello"(8bit), "World"(16bit)
  const sst = new Buf();
  sst.u32(2).u32(2);
  sst.u16(5).u8(0x00).bytes([...[..."Hello"].map((c) => c.charCodeAt(0))]);
  sst.u16(5).u8(0x01);
  for (const c of "World") sst.u16(c.charCodeAt(0));

  const globalsHead = [...rec(0x0809, [0x00, 0x06, 0x05, 0x00, 0x00, 0x00, 0x00, 0x00])];

  // Sheet1 BOUNDSHEET
  const sheetName1 = shortStr8("Sheet1");
  const bs1Data = [0, 0, 0, 0, 0x00, 0x00, sheetName1.length - 1, ...sheetName1];
  bs1Data[6] = 6;
  const boundsheet1 = rec(0x0085, bs1Data);

  // Sheet2 BOUNDSHEET (확인용: 두 번째 시트 lbPlyPos 보정 검증)
  const sheetName2 = shortStr8("Sheet2");
  const bs2Data = [0, 0, 0, 0, 0x00, 0x00, sheetName2.length - 1, ...sheetName2];
  bs2Data[6] = 6;
  const boundsheet2 = rec(0x0085, bs2Data);

  const sstRec = rec(0x00fc, sst.array);
  const eofGlobals = rec(0x000a, []);

  // Sheet1 substream: B1=LABELSST("Hello", ixfe=XF_INDEX), C1=NUMBER 42.5, B2=LABELSST("World", ixfe=0)
  const ws1Bof = rec(0x0809, [0x00, 0x06, 0x10, 0x00, 0x00, 0x00, 0x00, 0x00]);
  const labelsst1 = (() => {
    const b = new Buf();
    b.u16(0).u16(1).u16(XF_INDEX).u32(0); // r0,c1,ixfe=XF_INDEX,isst=0("Hello")
    return rec(0x00fd, b.array);
  })();
  const num = (() => {
    const b = new Buf();
    b.u16(0).u16(2).u16(0).f64(42.5); // r0,c2,ixfe=0,value=42.5
    return rec(0x0203, b.array);
  })();
  const labelsst2 = (() => {
    const b = new Buf();
    b.u16(1).u16(1).u16(0).u32(1); // r1,c1,ixfe=0,isst=1("World")
    return rec(0x00fd, b.array);
  })();
  const eofWs1 = rec(0x000a, []);

  // Sheet2 substream: A1=NUMBER 7
  const ws2Bof = rec(0x0809, [0x00, 0x06, 0x10, 0x00, 0x00, 0x00, 0x00, 0x00]);
  const num2 = (() => {
    const b = new Buf();
    b.u16(0).u16(0).u16(0).f64(7);
    return rec(0x0203, b.array);
  })();
  const eofWs2 = rec(0x000a, []);

  const globals = [...globalsHead, ...boundsheet1, ...boundsheet2, ...sstRec, ...eofGlobals];
  const ws1 = [...ws1Bof, ...labelsst1, ...num, ...labelsst2, ...eofWs1];
  const ws2 = [...ws2Bof, ...num2, ...eofWs2];
  const all = [...globals, ...ws1, ...ws2];

  // lbPlyPos 패치: boundsheet1 → ws1 BOF, boundsheet2 → ws2 BOF
  const ws1Abs = globals.length;
  const ws2Abs = globals.length + ws1.length;
  const bs1At = globalsHead.length + 4; // boundsheet1 data 시작
  const bs2At = globalsHead.length + boundsheet1.length + 4; // boundsheet2 data 시작
  patchU32(all, bs1At, ws1Abs);
  patchU32(all, bs2At, ws2Abs);

  return new Uint8Array(all);
}

function buildXls(): Uint8Array {
  return writeCfb(buildCfbModel({ Workbook: buildWorkbook(), ExtraStream: new Uint8Array([1, 2, 3, 4, 5]) }));
}

describe("xls 왕복(encode/decode)", () => {
  it("텍스트 셀을 편집하면 ixfe 보존하며 LABEL 로 갈아끼우고, 숫자/타 스트림은 보존", () => {
    const original = buildXls();
    const { html, manifest } = encodeXlsToHtml(original);

    // encode HTML 에 편집용 주소가 실려야 한다.
    expect(manifest.format).toBe("xls");
    expect(manifest.container).toBe("cfb");
    expect(html).toContain('data-cell="0!B1"');
    expect(html).toContain("Hello");

    // B1("Hello") → "Bonjour" 로 편집 (긴 텍스트 → 레코드 길이 변화 → 오프셋 시프트 유발)
    const edited = html.replace('data-cell="0!B1">Hello<', 'data-cell="0!B1">Bonjour<');
    expect(edited).not.toBe(html);

    const out = decodeHtmlToXls(edited, manifest);

    // 1) 다시 readCfb → 다른 스트림 보존 확인
    const cfb = readCfb(out);
    expect([...cfb.streams["ExtraStream"]!]).toEqual([1, 2, 3, 4, 5]);

    // 2) Workbook 재파싱
    const wb = parseWorkbook(cfb.streams["Workbook"]!);
    expect(wb.sheets.map((s) => s.name)).toEqual(["Sheet1", "Sheet2"]);

    const sheet1 = wb.sheets[0]!;
    const b1 = sheet1.cells.find((c) => c.row === 0 && c.col === 1)!;
    expect(b1.text).toBe("Bonjour"); // 편집 반영
    expect(b1.editable).toBe(true);
    expect(b1.ixfe).toBe(XF_INDEX); // XF index(스타일) 보존

    // 편집 안 한 텍스트 셀(World)도 그대로
    const b2 = sheet1.cells.find((c) => c.row === 1 && c.col === 1)!;
    expect(b2.text).toBe("World");

    // 숫자 셀 변화 없음
    const c1 = sheet1.cells.find((c) => c.row === 0 && c.col === 2)!;
    expect(c1.text).toBe("42.5");
    expect(c1.editable).toBe(false);

    // 3) Sheet2 의 lbPlyPos 보정이 올바른지 → Sheet2 숫자 셀이 정확히 파싱돼야
    const sheet2 = wb.sheets[1]!;
    const s2a1 = sheet2.cells.find((c) => c.row === 0 && c.col === 0)!;
    expect(s2a1.text).toBe("7");

    // 4) 미리보기로도 깨짐 없이 재파싱(오프셋 무손상)
    const preview = xlsToPreviewHtml(out);
    expect(preview).toContain("Bonjour");
    expect(preview).toContain("Sheet1");
    expect(preview).toContain("Sheet2");
    expect(preview).toContain("World");
    expect(preview).toContain("42.5");
    expect(preview).toContain("7");
  });

  it("16bit 문자(한글) 편집도 왕복 가능", () => {
    const original = buildXls();
    const { html, manifest } = encodeXlsToHtml(original);
    const edited = html.replace('data-cell="0!B1">Hello<', 'data-cell="0!B1">안녕<');
    const out = decodeHtmlToXls(edited, manifest);
    const cfb = readCfb(out);
    const wb = parseWorkbook(cfb.streams["Workbook"]!);
    const b1 = wb.sheets[0]!.cells.find((c) => c.row === 0 && c.col === 1)!;
    expect(b1.text).toBe("안녕");
    expect(b1.ixfe).toBe(XF_INDEX);
  });
});
