/**
 * BIFF8 공용 파서 헬퍼 — 미리보기(xls.ts)와 왕복(encode/decode)에서 공유한다.
 *
 * .xls 워크북 본문은 "Workbook"(아주 오래된 파일은 "Book") 스트림에 BIFF8 레코드
 * 스트림으로 담긴다. 각 레코드는 [2B type LE][2B length LE][data...]. 8224B 한도를
 * 넘는 SST 등은 CONTINUE(0x003C) 로 이어진다.
 *
 * 여기 두는 것: 레코드 분해, SST 파서, 짧은 Unicode string 읽기, RK 디코드, 그리고
 * 시트/셀을 한 번에 뽑는 parseWorkbook(셀 레코드의 절대 오프셋·ixfe 까지 노출).
 */

// ── BIFF 레코드 타입 ─────────────────────────────────────────────────────────
export const REC_BOF = 0x0809;
export const REC_EOF = 0x000a;
export const REC_BOUNDSHEET = 0x0085;
export const REC_SST = 0x00fc;
export const REC_CONTINUE = 0x003c;
export const REC_LABELSST = 0x00fd;
export const REC_LABEL = 0x0204;
export const REC_NUMBER = 0x0203;
export const REC_RK = 0x027e;
export const REC_MULRK = 0x00bd;

export interface BiffRecord {
  type: number;
  /** 데이터의 절대 시작 오프셋(스트림 기준). 레코드 헤더는 offset-4. */
  offset: number;
  data: Uint8Array;
}

/** BIFF 스트림을 [type,len,data] 레코드 배열로 분해(CONTINUE 도 그대로 포함). */
export function splitRecords(buf: Uint8Array): BiffRecord[] {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out: BiffRecord[] = [];
  let p = 0;
  while (p + 4 <= buf.length) {
    const type = dv.getUint16(p, true);
    const len = dv.getUint16(p + 2, true);
    const start = p + 4;
    if (start + len > buf.length) break; // 잘린 꼬리 방어
    out.push({ type, offset: start, data: buf.subarray(start, start + len) });
    p = start + len;
  }
  return out;
}

/** 레코드 한 개를 [type u16][len u16][data] 바이트로 직렬화. */
export function serializeRecord(type: number, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, type, true);
  dv.setUint16(2, data.length & 0xffff, true);
  out.set(data, 4);
  return out;
}

// ── SST(공유 문자열) 파서 ────────────────────────────────────────────────────

/** SST 레코드 + 그에 이어지는 CONTINUE 들을 합쳐 문자열 배열로 복원. */
export function parseSst(records: BiffRecord[], sstIndex: number): string[] {
  const chunks: Uint8Array[] = [records[sstIndex]!.data];
  for (let i = sstIndex + 1; i < records.length; i++) {
    if (records[i]!.type === REC_CONTINUE) chunks.push(records[i]!.data);
    else break;
  }

  let ci = 0;
  let co = 0;
  const cur = (): Uint8Array | undefined => chunks[ci];
  const atChunkEnd = (): boolean => {
    const c = cur();
    return !c || co >= c.length;
  };
  const advanceChunk = (): void => {
    while (ci < chunks.length && co >= (chunks[ci]?.length ?? 0)) {
      ci++;
      co = 0;
    }
  };
  const u8 = (): number => {
    advanceChunk();
    const c = cur();
    if (!c) return 0;
    return c[co++]!;
  };
  const u16 = (): number => {
    const lo = u8();
    const hi = u8();
    return lo | (hi << 8);
  };
  const u32 = (): number => u16() | (u16() << 16);

  u32();
  const unique = u32();

  const out: string[] = [];
  for (let n = 0; n < unique; n++) {
    advanceChunk();
    if (atChunkEnd()) break;
    const cch = u16();
    let grbit = u8();
    let is16 = (grbit & 0x01) !== 0;
    const rich = (grbit & 0x08) !== 0;
    const extSt = (grbit & 0x04) !== 0;
    const cRun = rich ? u16() : 0;
    const cbExt = extSt ? u32() : 0;

    let s = "";
    let read = 0;
    while (read < cch) {
      advanceChunk();
      if (atChunkEnd()) break;
      const c = cur()!;
      if (co === 0 && ci > 0 && read > 0) {
        grbit = u8();
        is16 = (grbit & 0x01) !== 0;
      }
      const avail = c.length - co;
      if (is16) {
        const canChars = Math.min(cch - read, Math.floor(avail / 2));
        for (let k = 0; k < canChars; k++) s += String.fromCharCode(u16());
        read += canChars;
        if (canChars === 0) co = c.length;
      } else {
        const canChars = Math.min(cch - read, avail);
        for (let k = 0; k < canChars; k++) s += String.fromCharCode(u8());
        read += canChars;
      }
    }
    for (let k = 0; k < cRun * 4; k++) u8();
    for (let k = 0; k < cbExt; k++) u8();

    out.push(s);
  }
  return out;
}

// ── 짧은 Unicode string ───────────────────────────────────────────────────────

/** 한 레코드 데이터 내 오프셋에서 짧은 Unicode string 읽기(byteCount=2). */
export function readShortUnicode(data: Uint8Array, off: number, cch: number): string {
  const grbit = data[off]!;
  const is16 = (grbit & 0x01) !== 0;
  let p = off + 1;
  let s = "";
  if (is16) {
    for (let k = 0; k < cch; k++) {
      s += String.fromCharCode(data[p]! | (data[p + 1]! << 8));
      p += 2;
    }
  } else {
    for (let k = 0; k < cch; k++) s += String.fromCharCode(data[p++]!);
  }
  return s;
}

/**
 * XLUnicodeString 직렬화: [2B cch][1B grbit][chars].
 * 임의의 char>0xFF 가 있으면 16bit(grbit bit0=1), 아니면 8bit.
 */
export function writeXLUnicodeString(s: string): Uint8Array {
  const cch = s.length;
  let is16 = false;
  for (let i = 0; i < cch; i++) {
    if (s.charCodeAt(i) > 0xff) {
      is16 = true;
      break;
    }
  }
  const body = is16 ? new Uint8Array(3 + cch * 2) : new Uint8Array(3 + cch);
  const dv = new DataView(body.buffer);
  dv.setUint16(0, cch, true);
  dv.setUint8(2, is16 ? 0x01 : 0x00);
  let p = 3;
  if (is16) {
    for (let i = 0; i < cch; i++) {
      dv.setUint16(p, s.charCodeAt(i), true);
      p += 2;
    }
  } else {
    for (let i = 0; i < cch; i++) body[p++] = s.charCodeAt(i) & 0xff;
  }
  return body;
}

// ── RK 값 디코드 ─────────────────────────────────────────────────────────────

/** RK 인코딩(30bit) → number. bit0=백분의1(/100), bit1=정수/IEEE754. */
export function decodeRk(rk: number): number {
  const div100 = (rk & 0x01) !== 0;
  const isInt = (rk & 0x02) !== 0;
  let val: number;
  if (isInt) {
    val = rk >> 2;
  } else {
    const buf = new ArrayBuffer(8);
    const dv = new DataView(buf);
    dv.setUint32(4, rk & 0xfffffffc, false);
    val = dv.getFloat64(0, false);
  }
  return div100 ? val / 100 : val;
}

/** 숫자 → 표시 문자열(서식 미적용, 원시값). */
export function numStr(v: number): string {
  if (!Number.isFinite(v)) return "";
  if (Number.isInteger(v)) return String(v);
  return String(Math.round(v * 1e10) / 1e10);
}

// ── 시트/셀 파싱 ──────────────────────────────────────────────────────────────

/** 한 셀의 파싱 결과(왕복용 메타 포함). */
export interface ParsedCell {
  row: number;
  col: number;
  text: string;
  /** 텍스트 셀(LABELSST/LABEL)인가. 숫자/RK/수식은 false → 편집 불가. */
  editable: boolean;
  /** 편집 가능 셀이면 그 셀 레코드의 XF index(ixfe). 스타일 보존용. */
  ixfe: number;
}

export interface Sheet {
  name: string;
  /** BOUNDSHEET 가 가리키는 substream BOF 절대 오프셋. */
  bofOffset: number;
  cells: ParsedCell[];
  maxRow: number;
  maxCol: number;
}

export interface Workbook {
  sheets: Sheet[];
  records: BiffRecord[];
}

/** BIFF8 워크북 스트림 → 시트별 셀(왕복용 메타 포함). */
export function parseWorkbook(buf: Uint8Array): Workbook {
  const records = splitRecords(buf);

  const sheets: Sheet[] = [];
  let sst: string[] = [];
  for (let i = 0; i < records.length; i++) {
    const rec = records[i]!;
    if (rec.type === REC_BOUNDSHEET) {
      const dv = new DataView(rec.data.buffer, rec.data.byteOffset, rec.data.byteLength);
      const bofPos = dv.getUint32(0, true);
      const cch = rec.data[6]!;
      const name = readShortUnicode(rec.data, 7, cch);
      sheets.push({ name, bofOffset: bofPos, cells: [], maxRow: 0, maxCol: 0 });
    } else if (rec.type === REC_SST) {
      sst = parseSst(records, i);
    }
  }

  const bySheetStart = sheets
    .map((s, idx) => ({ idx, off: s.bofOffset }))
    .sort((a, b) => a.off - b.off);

  const sheetIndexAt = (recHeaderOffset: number): number => {
    let found = -1;
    for (const { idx, off } of bySheetStart) {
      if (recHeaderOffset >= off) found = idx;
      else break;
    }
    return found;
  };

  const push = (si: number, cell: ParsedCell): void => {
    if (si < 0 || si >= sheets.length) return;
    const s = sheets[si]!;
    s.cells.push(cell);
    if (cell.row > s.maxRow) s.maxRow = cell.row;
    if (cell.col > s.maxCol) s.maxCol = cell.col;
  };

  for (const rec of records) {
    const headerOff = rec.offset - 4;
    const dv = new DataView(rec.data.buffer, rec.data.byteOffset, rec.data.byteLength);
    switch (rec.type) {
      case REC_LABELSST: {
        const r = dv.getUint16(0, true);
        const c = dv.getUint16(2, true);
        const ixfe = dv.getUint16(4, true);
        const isst = dv.getUint32(6, true);
        push(sheetIndexAt(headerOff), { row: r, col: c, text: sst[isst] ?? "", editable: true, ixfe });
        break;
      }
      case REC_LABEL: {
        const r = dv.getUint16(0, true);
        const c = dv.getUint16(2, true);
        const ixfe = dv.getUint16(4, true);
        const cch = dv.getUint16(6, true);
        const text = readShortUnicode(rec.data, 8, cch);
        push(sheetIndexAt(headerOff), { row: r, col: c, text, editable: true, ixfe });
        break;
      }
      case REC_NUMBER: {
        const r = dv.getUint16(0, true);
        const c = dv.getUint16(2, true);
        const v = dv.getFloat64(6, true);
        push(sheetIndexAt(headerOff), { row: r, col: c, text: numStr(v), editable: false, ixfe: 0 });
        break;
      }
      case REC_RK: {
        const r = dv.getUint16(0, true);
        const c = dv.getUint16(2, true);
        const rk = dv.getUint32(6, true);
        push(sheetIndexAt(headerOff), { row: r, col: c, text: numStr(decodeRk(rk)), editable: false, ixfe: 0 });
        break;
      }
      case REC_MULRK: {
        const r = dv.getUint16(0, true);
        const c1 = dv.getUint16(2, true);
        const lastCol = dv.getUint16(rec.data.length - 2, true);
        const si = sheetIndexAt(headerOff);
        let p = 4;
        for (let c = c1; c <= lastCol; c++) {
          const rk = dv.getUint32(p + 2, true);
          push(si, { row: r, col: c, text: numStr(decodeRk(rk)), editable: false, ixfe: 0 });
          p += 6;
        }
        break;
      }
      default:
        break;
    }
  }

  return { sheets, records };
}

// ── A1 주소 ────────────────────────────────────────────────────────────────────

/** 0-기준 열 index → 열 문자(A, B, …, AA, …). */
export function colLetter(idx0: number): string {
  let s = "";
  let n = idx0 + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** (row0, col0) → A1 주소(예: 0,1 → "B1"). */
export function a1(row0: number, col0: number): string {
  return `${colLetter(col0)}${row0 + 1}`;
}

/** A1 주소 → {row, col} (0-기준). 파싱 실패 시 null. */
export function parseA1(addr: string): { row: number; col: number } | null {
  const m = /^([A-Z]+)(\d+)$/.exec(addr.trim().toUpperCase());
  if (!m) return null;
  const letters = m[1]!;
  let col = 0;
  for (let i = 0; i < letters.length; i++) col = col * 26 + (letters.charCodeAt(i) - 64);
  const row = parseInt(m[2]!, 10);
  if (col < 1 || row < 1) return null;
  return { row: row - 1, col: col - 1 };
}
