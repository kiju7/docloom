import { describe, it, expect } from "vitest";
import { xlsAdapter, xlsToPreviewHtml } from "../src/formats/xls.js";
import { notImplemented } from "../src/core/format.js";
import { writeCfb, buildCfbModel } from "../src/core/cfb.js";

// ── BIFF8 Workbook 스트림 빌더(테스트용 최소 구성) ───────────────────────────

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

/** 레코드: [type][len][data]. */
function rec(type: number, data: number[]): number[] {
  return [type & 0xff, (type >> 8) & 0xff, data.length & 0xff, (data.length >> 8) & 0xff, ...data];
}

/** 짧은 Unicode string(8bit, ASCII): [1B grbit=0][chars...]. */
function shortStr8(s: string): number[] {
  return [0x00, ...[...s].map((c) => c.charCodeAt(0))];
}

describe("xls 어댑터 계약", () => {
  it("이제 왕복(encode/decode)을 지원한다", () => {
    expect(xlsAdapter.supportsRoundTrip).toBe(true);
    expect(typeof xlsAdapter.encode).toBe("function");
    expect(typeof xlsAdapter.decode).toBe("function");
  });
  it("detect 는 false(컨테이너 라우팅)", () => {
    expect(xlsAdapter.detect({})).toBe(false);
  });
  it("notImplemented 헬퍼 자체도 던진다", () => {
    expect(() => notImplemented("xls", "encode")).toThrow();
  });
});

describe("xls BIFF8 파싱(구성한 Workbook 스트림)", () => {
  function buildWorkbook(): Uint8Array {
    // 1) SST: total=2, unique=2, 문자열 "Hello"(8bit), "World"(16bit)
    const sst = new Buf();
    sst.u32(2).u32(2);
    // "Hello": cch=5, grbit=0(8bit)
    sst.u16(5).u8(0x00).bytes([...[..."Hello"].map((c) => c.charCodeAt(0))]);
    // "World": cch=5, grbit=1(16bit)
    sst.u16(5).u8(0x01);
    for (const c of "World") sst.u16(c.charCodeAt(0));

    // 글로벌 substream 레코드 모음(BOUNDSHEET 의 bofOffset 을 나중에 패치).
    const globalsHead = [
      ...rec(0x0809, [0x00, 0x06, 0x05, 0x00, 0x00, 0x00, 0x00, 0x00]), // BOF (workbook globals)
    ];
    // BOUNDSHEET: [4B bofPos][2B grbit][1B cch][unistr]  — 시트명 "Sheet1"
    const sheetName = shortStr8("Sheet1");
    const boundsheetData = [0, 0, 0, 0, 0x00, 0x00, sheetName.length - 1, ...sheetName];
    // 위 boundsheet 의 cch 위치 보정: data[6] = 문자수 = "Sheet1".length
    boundsheetData[6] = 6;
    const boundsheet = rec(0x0085, boundsheetData);
    const sstRec = rec(0x00fc, sst.array);
    const eofGlobals = rec(0x000a, []);

    // 워크시트 substream
    // 셀: B1(r0,c1)=LABELSST isst 0 ("Hello"), C1(r0,c2)=NUMBER 42.5,
    //     B2(r1,c1)=RK 정수 100, C2(r1,c2)=LABELSST isst 1 ("World")
    const wsBof = rec(0x0809, [0x00, 0x06, 0x10, 0x00, 0x00, 0x00, 0x00, 0x00]); // BOF worksheet(dt=0x0010)
    const labelsst1 = rec(0x00fd, [0, 0, 1, 0, 0, 0, 0, 0, 0, 0]); // r=0,c=1,ixfe=0,isst=0
    const num = (() => {
      const b = new Buf();
      b.u16(0).u16(2).u16(0).f64(42.5); // r=0,c=2,ixfe=0,value
      return rec(0x0203, b.array);
    })();
    const rk = (() => {
      const b = new Buf();
      // RK 정수 100: (100<<2)|0x02
      b.u16(1).u16(1).u16(0).u32((100 << 2) | 0x02);
      return rec(0x027e, b.array);
    })();
    const labelsst2 = rec(0x00fd, [1, 0, 2, 0, 0, 0, 1, 0, 0, 0]); // r=1,c=2,ixfe=0,isst=1
    const eofWs = rec(0x000a, []);

    // 조립 + bofPos 패치
    const globals = [...globalsHead, ...boundsheet, ...sstRec, ...eofGlobals];
    const ws = [...wsBof, ...labelsst1, ...num, ...rk, ...labelsst2, ...eofWs];
    const all = [...globals, ...ws];
    const wsAbsOffset = globals.length; // 워크시트 BOF 헤더의 절대 오프셋
    // boundsheet bofPos(글로벌 내 위치 = globalsHead.length + 4) 의 data[0..3] 패치
    const bofPatchAt = globalsHead.length + 4; // rec 헤더 4B 다음이 data 시작
    all[bofPatchAt] = wsAbsOffset & 0xff;
    all[bofPatchAt + 1] = (wsAbsOffset >> 8) & 0xff;
    all[bofPatchAt + 2] = (wsAbsOffset >> 16) & 0xff;
    all[bofPatchAt + 3] = (wsAbsOffset >> 24) & 0xff;

    return new Uint8Array(all);
  }

  function buildXls(): Uint8Array {
    return writeCfb(buildCfbModel({ Workbook: buildWorkbook() }));
  }

  it("시트 이름과 셀 값(문자열/숫자/RK)을 렌더한다", () => {
    const html = xlsToPreviewHtml(buildXls());
    expect(html).toContain("Sheet1");
    expect(html).toContain("Hello");
    expect(html).toContain("World");
    expect(html).toContain("42.5");
    expect(html).toContain("100");
  });

  it("어댑터 toPreviewHtml 경로도 동작한다", () => {
    const html = xlsAdapter.toPreviewHtml(buildXls(), {});
    expect(html).toContain("<table");
    expect(html).toContain("Sheet1");
  });
});
