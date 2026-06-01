/**
 * .doc(Word 97-2003 바이너리) 서식 파서 — 순수 TypeScript.
 *
 * doc-fib.ts 가 텍스트(piece table)만 다뤘다면, 이 모듈은 **서식**을 복원한다:
 *   - CHPX(글자속성: 크기·굵게·기울임·밑줄·색·글꼴)  ← PlcfBteChpx + ChpxFkp
 *   - PAPX(문단속성: 정렬·들여쓰기·간격·istd·표여부)   ← PlcfBtePapx + PapxFkp
 *   - STSH(스타일시트: istd→기본 글자/문단 서식, 상속체인)
 *   - PlcfSed(섹션경계 → 페이지/용지) — 본문은 renderer 가 사용.
 *
 * 핵심 개념(MS-DOC):
 *   - 서식은 WordDocument 스트림을 512바이트 "FKP(Formatted Disk Page)" 로 나눠 저장한다.
 *   - bin table(PlcfBteChpx/PlcfBtePapx, Table 스트림에 있음)이 FC구간→FKP페이지번호 를 매핑한다.
 *   - FKP 안에는 FC경계 배열 + 각 구간의 grpprl(SPRM 목록)이 들어있다.
 *   - SPRM(Single Property Modifier) = 2바이트 opcode + 가변 operand. 실제 속성값(크기 등).
 *
 * 모든 파싱은 방어적(try/catch 친화)이라, 일부가 깨져도 텍스트추출은 유지된다.
 */
import { pictureFromPicf, type DocPicture } from "./doc-images.js";

/** 해석된 글자 속성(미리보기용). undefined = 미지정(상속/기본). */
export interface ChpProps {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  /** 숨김 글자(필드 instruction 등). true 면 렌더 생략. */
  vanish?: boolean;
  /** 글자 크기(half-points). 22 = 11pt. */
  halfPts?: number;
  /** "#rrggbb" 또는 undefined. */
  color?: string;
  /** 하이라이트 색 인덱스(ico)→"#rrggbb". */
  highlight?: string;
  /** 글꼴 테이블 인덱스(ftc). */
  ftc?: number;
  /** 첨자/위첨자. */
  vertAlign?: "super" | "sub";
  /** 윗줄/소문자 변형 등은 생략. */
}

/** 해석된 문단 속성. */
export interface PapProps {
  /** 0=left 1=center 2=right 3=both/justify 4=distribute. */
  jc?: number;
  /** 왼/오른쪽 들여쓰기(twips, 1440=1inch). */
  dxaLeft?: number;
  dxaRight?: number;
  /** 첫줄 들여쓰기(twips, 음수=내어쓰기). */
  dxaLeft1?: number;
  /** 문단 앞/뒤 간격(twips). */
  dyaBefore?: number;
  dyaAfter?: number;
  /** 스타일 인덱스. */
  istd?: number;
  /** 표 안 문단. */
  inTable?: boolean;
  /** 표 행 종결 문단(TTP, row mark). */
  ttp?: boolean;
  /** 개요/목록 수준(0-8). */
  ilvl?: number;
  /** 목록 적용 인덱스(1-based ilfo). 0/undefined = 목록 아님. */
  ilfo?: number;
}

/** FC구간 → grpprl 한 덩어리. */
interface FcGrpprl {
  fcFirst: number;
  fcLim: number;
  istd?: number;
  grpprl: Uint8Array;
}

// ───────────────────────── bin table(PLC) ─────────────────────────

/** PlcfBteChpx/PlcfBtePapx: (n+1)*FC(4B) + n*PN(4B). PN 하위 22bit = FKP 페이지번호. */
function parseBinTable(table: Uint8Array, fc: number, lcb: number): { fcs: number[]; pns: number[] } {
  if (lcb < 8 || fc + lcb > table.length) return { fcs: [], pns: [] };
  // lcb = (n+1)*4 + n*4 = 8n+4
  if ((lcb - 4) % 8 !== 0) return { fcs: [], pns: [] };
  const n = (lcb - 4) / 8;
  const dv = new DataView(table.buffer, table.byteOffset, table.byteLength);
  const fcs: number[] = [];
  for (let i = 0; i <= n; i++) fcs.push(dv.getUint32(fc + i * 4, true));
  const pnBase = fc + (n + 1) * 4;
  const pns: number[] = [];
  for (let i = 0; i < n; i++) pns.push(dv.getUint32(pnBase + i * 4, true) & 0x003fffff);
  return { fcs, pns };
}

// ───────────────────────── FKP 파싱 ─────────────────────────

const FKP_SIZE = 512;

/** ChpxFkp(512B): rgfc[(crun+1)] + rgb[crun](1B word-offset) + ... crun=byte[511]. */
function parseChpxFkp(wd: Uint8Array, pn: number): FcGrpprl[] {
  const base = pn * FKP_SIZE;
  if (base + FKP_SIZE > wd.length) return [];
  const page = wd.subarray(base, base + FKP_SIZE);
  const dv = new DataView(page.buffer, page.byteOffset, page.byteLength);
  const crun = page[FKP_SIZE - 1]!;
  if (crun === 0 || 4 * (crun + 1) + crun > FKP_SIZE - 1) return [];
  const out: FcGrpprl[] = [];
  const rgbBase = 4 * (crun + 1);
  for (let i = 0; i < crun; i++) {
    const fcFirst = dv.getUint32(i * 4, true);
    const fcLim = dv.getUint32((i + 1) * 4, true);
    const off = page[rgbBase + i]! * 2;
    let grpprl: Uint8Array = new Uint8Array(0);
    if (off !== 0 && off < FKP_SIZE) {
      const cb = page[off]!;
      if (off + 1 + cb <= FKP_SIZE) grpprl = page.subarray(off + 1, off + 1 + cb);
    }
    out.push({ fcFirst, fcLim, grpprl });
  }
  return out;
}

/** PapxFkp(512B): rgfc[(cpara+1)] + rgbx[cpara](13B: bOff 1B + PHE 12B) + ... cpara=byte[511]. */
function parsePapxFkp(wd: Uint8Array, pn: number): FcGrpprl[] {
  const base = pn * FKP_SIZE;
  if (base + FKP_SIZE > wd.length) return [];
  const page = wd.subarray(base, base + FKP_SIZE);
  const dv = new DataView(page.buffer, page.byteOffset, page.byteLength);
  const cpara = page[FKP_SIZE - 1]!;
  if (cpara === 0 || 4 * (cpara + 1) + 13 * cpara > FKP_SIZE - 1) return [];
  const out: FcGrpprl[] = [];
  const bxBase = 4 * (cpara + 1);
  for (let i = 0; i < cpara; i++) {
    const fcFirst = dv.getUint32(i * 4, true);
    const fcLim = dv.getUint32((i + 1) * 4, true);
    const bOff = page[bxBase + i * 13]! * 2;
    let istd: number | undefined;
    let grpprl: Uint8Array = new Uint8Array(0);
    if (bOff !== 0 && bOff < FKP_SIZE) {
      // PapxInFkp: cb(1B). cb!=0 → grpprl 길이 2*cb-1, 선두 istd(2B). cb==0 → cb'(1B), 길이 2*cb'.
      let cb = page[bOff]!;
      let pos = bOff + 1;
      let lenWithIstd: number;
      if (cb !== 0) {
        lenWithIstd = 2 * cb - 1;
      } else {
        cb = page[pos]!;
        pos += 1;
        lenWithIstd = 2 * cb;
      }
      if (lenWithIstd >= 2 && pos + lenWithIstd <= FKP_SIZE) {
        istd = dv.getUint16(pos, true);
        grpprl = page.subarray(pos + 2, pos + lenWithIstd);
      }
    }
    out.push({ fcFirst, fcLim, istd, grpprl });
  }
  return out;
}

/** bin table 의 모든 FKP 를 펼쳐 FC오름차순 구간목록을 만든다. */
function buildFcMap(
  wd: Uint8Array,
  table: Uint8Array,
  fc: number,
  lcb: number,
  parseFkp: (wd: Uint8Array, pn: number) => FcGrpprl[],
): FcGrpprl[] {
  const { pns } = parseBinTable(table, fc, lcb);
  const all: FcGrpprl[] = [];
  for (const pn of pns) all.push(...parseFkp(wd, pn));
  all.sort((a, b) => a.fcFirst - b.fcFirst);
  return all;
}

/** FC오름차순 구간목록에서 fc 를 포함하는 항목 검색(이진탐색). */
function findByFc(entries: FcGrpprl[], fc: number): FcGrpprl | undefined {
  let lo = 0,
    hi = entries.length - 1,
    found: FcGrpprl | undefined;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const e = entries[mid]!;
    if (fc < e.fcFirst) hi = mid - 1;
    else if (fc >= e.fcLim) lo = mid + 1;
    else {
      found = e;
      break;
    }
  }
  return found;
}

// ───────────────────────── SPRM 해석 ─────────────────────────

/** sprm operand 길이(spra 코드별). spra=6 은 가변(특수). */
function operandLen(sprm: number, gp: Uint8Array, at: number): number {
  const spra = (sprm >> 13) & 0x7;
  switch (spra) {
    case 0:
    case 1:
      return 1;
    case 2:
    case 4:
    case 5:
      return 2;
    case 3:
      return 4;
    case 7:
      return 3;
    case 6: {
      // 가변: 보통 다음 1바이트가 길이. 단, sprmTDefTable(0xD608)·sprmPChgTabsPapx(0xC615)은 2바이트 길이.
      if (sprm === 0xd608 || sprm === 0xc615) {
        const cb = at + 1 < gp.length ? gp[at]! | (gp[at + 1]! << 8) : 0;
        return 2 + Math.max(0, cb - 1);
      }
      const cb = at < gp.length ? gp[at]! : 0;
      return 1 + cb;
    }
    default:
      return 0;
  }
}

/** ico(0-16) 색 인덱스 → "#rrggbb". 0/auto=검정. */
const ICO_COLORS = [
  "#000000", "#000000", "#0000ff", "#00ffff", "#00ff00", "#ff00ff", "#ff0000",
  "#ffff00", "#ffffff", "#000080", "#008080", "#008000", "#800080", "#800000",
  "#808000", "#808080", "#c0c0c0",
];

/** 토글 SPRM 값 해석: 0=off,1=on,128=상속(미변경),129=반전(상속+토글). */
function toggle(prev: boolean | undefined, v: number): boolean | undefined {
  if (v === 0) return false;
  if (v === 1) return true;
  if (v === 128) return prev; // 상속 유지
  if (v === 129) return !prev; // 반전
  return prev;
}

/** CHPX grpprl 의 SPRM 들을 base 위에 적용. */
export function applyChpSprms(grpprl: Uint8Array, base: ChpProps): ChpProps {
  const c: ChpProps = { ...base };
  const dv = new DataView(grpprl.buffer, grpprl.byteOffset, grpprl.byteLength);
  let i = 0;
  while (i + 2 <= grpprl.length) {
    const sprm = dv.getUint16(i, true);
    const opAt = i + 2;
    const olen = operandLen(sprm, grpprl, opAt);
    if (olen <= 0 || opAt + olen > grpprl.length) break;
    const b0 = grpprl[opAt]!;
    switch (sprm) {
      case 0x0835: // sprmCFBold
        c.bold = toggle(base.bold, b0);
        break;
      case 0x0836: // sprmCFItalic
        c.italic = toggle(base.italic, b0);
        break;
      case 0x0837: // sprmCFStrike
        c.strike = toggle(base.strike, b0);
        break;
      case 0x0838: // sprmCFVanish (숨김)
        c.vanish = toggle(base.vanish, b0);
        break;
      case 0x2a3e: // sprmCKul (밑줄 종류; 0=none)
        c.underline = b0 !== 0;
        break;
      case 0x4a43: // sprmCHps (half-points)
        c.halfPts = dv.getUint16(opAt, true);
        break;
      case 0x4a4f: // sprmCRgFtc0 (font face index)
      case 0x4a50: // sprmCRgFtc1
      case 0x4a51: // sprmCRgFtc2
        c.ftc = dv.getUint16(opAt, true);
        break;
      case 0x2a42: // sprmCIco (색 인덱스)
        c.color = ICO_COLORS[b0] ?? c.color;
        break;
      case 0x6870: { // sprmCCv (COLORREF RGB 4B)
        const r = grpprl[opAt]!, g = grpprl[opAt + 1]!, bl = grpprl[opAt + 2]!;
        c.color = rgbHex(r, g, bl);
        break;
      }
      case 0x2a0c: // sprmCHighlight
        c.highlight = ICO_COLORS[b0] ?? undefined;
        break;
      case 0x3a48: // sprmCIss (super/sub: 1=super,2=sub)
        c.vertAlign = b0 === 1 ? "super" : b0 === 2 ? "sub" : undefined;
        break;
      default:
        break;
    }
    i = opAt + olen;
  }
  return c;
}

/** PAPX grpprl 의 SPRM 들을 base 위에 적용. */
export function applyPapSprms(grpprl: Uint8Array, base: PapProps): PapProps {
  const p: PapProps = { ...base };
  const dv = new DataView(grpprl.buffer, grpprl.byteOffset, grpprl.byteLength);
  let i = 0;
  while (i + 2 <= grpprl.length) {
    const sprm = dv.getUint16(i, true);
    const opAt = i + 2;
    const olen = operandLen(sprm, grpprl, opAt);
    if (olen <= 0 || opAt + olen > grpprl.length) break;
    const b0 = grpprl[opAt]!;
    switch (sprm) {
      case 0x2403: // sprmPJc80 (정렬)
      case 0x2461: // sprmPJc100
        p.jc = b0;
        break;
      case 0x840f: // sprmPDxaLeft (twips, signed)
        p.dxaLeft = dv.getInt16(opAt, true);
        break;
      case 0x840e: // sprmPDxaRight
        p.dxaRight = dv.getInt16(opAt, true);
        break;
      case 0x8411: // sprmPDxaLeft1 (first line, signed)
        p.dxaLeft1 = dv.getInt16(opAt, true);
        break;
      case 0x845d: // sprmPDxaLeft (newer)
        p.dxaLeft = dv.getInt16(opAt, true);
        break;
      case 0x845e: // sprmPDxaRight (newer)
        p.dxaRight = dv.getInt16(opAt, true);
        break;
      case 0x8460: // sprmPDxaLeft1 (newer)
        p.dxaLeft1 = dv.getInt16(opAt, true);
        break;
      case 0xa413: // sprmPDyaBefore
        p.dyaBefore = dv.getUint16(opAt, true);
        break;
      case 0xa414: // sprmPDyaAfter
        p.dyaAfter = dv.getUint16(opAt, true);
        break;
      case 0x2416: // sprmPFInTable
        p.inTable = b0 !== 0;
        break;
      case 0x2417: // sprmPFTtp (table terminating paragraph)
        p.ttp = b0 !== 0;
        break;
      case 0x260a: // sprmPIlvl
        p.ilvl = b0;
        break;
      case 0x460b: // sprmPIlfo (목록 적용 인덱스)
        p.ilfo = dv.getUint16(opAt, true);
        break;
      case 0x4600: // sprmPIstd
        p.istd = dv.getUint16(opAt, true);
        break;
      default:
        break;
    }
    i = opAt + olen;
  }
  return p;
}

function rgbHex(r: number, g: number, b: number): string {
  const h = (n: number) => n.toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

// ───────────────────────── 스타일시트(STSH) ─────────────────────────

export interface StyleEntry {
  name: string;
  /** stk: 1=문단 2=글자 3=표 4=목록. */
  stk: number;
  /** 부모 스타일 istd(0x0FFF=없음). */
  istdBase: number;
  /** 이 스타일이 직접 지정한 글자/문단 grpprl. */
  papxGrpprl?: Uint8Array;
  chpxGrpprl?: Uint8Array;
}

/** 스타일시트를 파싱해 istd→StyleEntry 배열을 만든다(실패시 빈 배열). */
export function parseStylesheet(table: Uint8Array, fc: number, lcb: number): StyleEntry[] {
  try {
    if (lcb < 4 || fc + lcb > table.length) return [];
    const dv = new DataView(table.buffer, table.byteOffset, table.byteLength);
    const cbStshi = dv.getUint16(fc, true);
    const stshiStart = fc + 2;
    const cstd = dv.getUint16(stshiStart, true);
    const cbSTDBaseInFile = dv.getUint16(stshiStart + 2, true);
    let p = stshiStart + cbStshi;
    const end = fc + lcb;
    const styles: StyleEntry[] = [];
    for (let istd = 0; istd < cstd; istd++) {
      if (p + 2 > end) break;
      const cbStd = dv.getUint16(p, true);
      p += 2;
      if (cbStd === 0) {
        styles.push({ name: "", stk: 0, istdBase: 0x0fff });
        continue;
      }
      const stdStart = p;
      const stdEnd = p + cbStd;
      p = stdEnd; // 다음 STD 로
      if (stdEnd > end) break;
      // STDF base (cbSTDBaseInFile 바이트). 워드97: 10바이트.
      // +0 u16: sti(12)+...  +2 u16: stk(4)+istdBase(12)  +4 u16: cupx(4)+istdNext(12)
      const w2 = dv.getUint16(stdStart + 2, true);
      const stk = w2 & 0x000f;
      const istdBase = (w2 >> 4) & 0x0fff;
      const w4 = dv.getUint16(stdStart + 4, true);
      const cupx = w4 & 0x000f;
      // 스타일 이름(Xstz): cbSTDBaseInFile 뒤. Xst = cch(u16) + cch*2 UTF-16 + chTerm(u16).
      let q = stdStart + cbSTDBaseInFile;
      let name = "";
      if (q + 2 <= stdEnd) {
        const cch = dv.getUint16(q, true);
        q += 2;
        if (q + cch * 2 <= stdEnd) {
          for (let k = 0; k < cch; k++) name += String.fromCharCode(dv.getUint16(q + k * 2, true));
          q += cch * 2;
        }
        q += 2; // chTerm
      }
      // grLPUpxSw: 문단스타일(stk=1) → UpxPapx, UpxChpx. 글자스타일(stk=2) → UpxChpx.
      q = (q + 1) & ~1; // even 정렬
      let papxGrpprl: Uint8Array | undefined;
      let chpxGrpprl: Uint8Array | undefined;
      const readUpx = (): Uint8Array | undefined => {
        if (q + 2 > stdEnd) return undefined;
        const cbUpx = dv.getUint16(q, true);
        q += 2;
        if (q + cbUpx > stdEnd) return undefined;
        const slice = new Uint8Array(table.buffer, table.byteOffset + q, cbUpx);
        q += cbUpx;
        q = (q + 1) & ~1; // 패딩
        return slice;
      };
      if (stk === 1 && cupx >= 1) {
        // UpxPapx: istd(2B) + grpprl
        const upxPapx = readUpx();
        if (upxPapx && upxPapx.length >= 2) papxGrpprl = upxPapx.subarray(2);
        const upxChpx = readUpx();
        if (upxChpx) chpxGrpprl = upxChpx;
      } else if (stk === 2 && cupx >= 1) {
        const upxChpx = readUpx();
        if (upxChpx) chpxGrpprl = upxChpx;
      }
      styles.push({ name, stk, istdBase, papxGrpprl, chpxGrpprl });
    }
    return styles;
  } catch {
    return [];
  }
}

/** istd 의 글자속성을 상속체인 따라 해석. */
export function resolveStyleChp(styles: StyleEntry[], istd: number, base: ChpProps): ChpProps {
  const chain: StyleEntry[] = [];
  let cur = istd;
  const seen = new Set<number>();
  while (cur !== 0x0fff && cur < styles.length && !seen.has(cur)) {
    seen.add(cur);
    const s = styles[cur]!;
    chain.push(s);
    cur = s.istdBase;
  }
  // 부모→자식 순으로 적용.
  let c = { ...base };
  for (let i = chain.length - 1; i >= 0; i--) {
    const g = chain[i]!.chpxGrpprl;
    if (g && g.length) c = applyChpSprms(g, c);
  }
  return c;
}

/** istd 의 문단속성을 상속체인 따라 해석. */
export function resolveStylePap(styles: StyleEntry[], istd: number, base: PapProps): PapProps {
  const chain: StyleEntry[] = [];
  let cur = istd;
  const seen = new Set<number>();
  while (cur !== 0x0fff && cur < styles.length && !seen.has(cur)) {
    seen.add(cur);
    const s = styles[cur]!;
    chain.push(s);
    cur = s.istdBase;
  }
  let p = { ...base };
  for (let i = chain.length - 1; i >= 0; i--) {
    const g = chain[i]!.papxGrpprl;
    if (g && g.length) p = applyPapSprms(g, p);
  }
  // 스타일 글자속성도 같이 쓰려면 호출측에서 resolveStyleChp 병행.
  return p;
}

// ───────────────────────── 폰트 테이블(SttbfFfn) ─────────────────────────

/** SttbfFfn 에서 ftc→글꼴명 배열. 베스트에포트(실패시 빈 배열). */
export function parseFontTable(table: Uint8Array, fc: number, lcb: number): string[] {
  try {
    if (lcb < 2 || fc + lcb > table.length) return [];
    const dv = new DataView(table.buffer, table.byteOffset, table.byteLength);
    // 확장 STTB: 선두 u16 == 0xFFFF 면 확장. 그 뒤 cData(u16), cbExtra(u16).
    let p = fc;
    const flag = dv.getUint16(p, true);
    let cData: number;
    if (flag === 0xffff) {
      p += 2;
      cData = dv.getUint16(p, true);
      p += 2;
      p += 2; // cbExtra
    } else {
      cData = flag;
      p += 2;
      p += 2;
    }
    const end = fc + lcb;
    const fonts: string[] = [];
    for (let i = 0; i < cData && p < end; i++) {
      // FFN: cbFfnM1(1B) = 전체 FFN 바이트수-1. 이름은 xszFfn(UTF-16, NUL종결) @ FFN+0x28? (워드 가변)
      const cbFfn = dv.getUint8(p) + 1;
      const ffnStart = p;
      const ffnEnd = p + cbFfn;
      if (ffnEnd > end) break;
      // xszFfn: FFN 고정부(0x28=40바이트) 이후 UTF-16 NUL종결 문자열.
      let name = "";
      let q = ffnStart + 40;
      while (q + 1 < ffnEnd) {
        const cu = dv.getUint16(q, true);
        if (cu === 0) break;
        name += String.fromCharCode(cu);
        q += 2;
      }
      fonts.push(name);
      p = ffnEnd;
    }
    return fonts;
  } catch {
    return [];
  }
}

// ───────────────────────── 섹션(PlcfSed) ─────────────────────────

/** 섹션 경계 CP 목록(첫 항목 제외한 경계에서 페이지/섹션 분리). */
export function parseSectionBoundaries(table: Uint8Array, fc: number, lcb: number): number[] {
  // PlcfSed: (n+1)*CP(4B) + n*SED(12B).  lcb = (n+1)*4 + n*12 = 16n+4.
  if (lcb < 4 || (lcb - 4) % 16 !== 0 || fc + lcb > table.length) return [];
  const n = (lcb - 4) / 16;
  const dv = new DataView(table.buffer, table.byteOffset, table.byteLength);
  const cps: number[] = [];
  for (let i = 0; i <= n; i++) cps.push(dv.getInt32(fc + i * 4, true));
  return cps;
}

// ───────────────────────── 통합 인덱스 ─────────────────────────

/** FC구간 → 그림(Data 스트림에서 추출한 data URI). */
interface PicEntry {
  fcFirst: number;
  fcLim: number;
  pic: DocPicture;
}

/** 서식 조회용 인덱스. renderer 가 FC 로 CHPX/PAPX 를 조회한다. */
export interface DocFormatIndex {
  chpMap: FcGrpprl[];
  papMap: FcGrpprl[];
  styles: StyleEntry[];
  fonts: string[];
  /** 섹션 경계 CP 배열. */
  sectionCps: number[];
  /** 그림 FC구간(0x01 picture run 위치 매칭용). */
  picMap: PicEntry[];
  /** 목록 자동번호 정의(LST/LFO). */
  listInfo: ListInfo;
  /** 문서 기본 글자/문단 속성. */
  defaultChp: ChpProps;
  defaultPap: PapProps;
}

export function buildFormatIndex(
  wordDocument: Uint8Array,
  table: Uint8Array,
  fib: import("./doc-fib.js").FibInfo,
  dataStream?: Uint8Array,
): DocFormatIndex {
  const chpMap = safe(() => buildFcMap(wordDocument, table, fib.fcPlcfBteChpx, fib.lcbPlcfBteChpx, parseChpxFkp), []);
  const papMap = safe(() => buildFcMap(wordDocument, table, fib.fcPlcfBtePapx, fib.lcbPlcfBtePapx, parsePapxFkp), []);
  const styles = safe(() => parseStylesheet(table, fib.fcStshf, fib.lcbStshf), []);
  const fonts = safe(() => parseFontTable(table, fib.fcSttbfFfn, fib.lcbSttbfFfn), []);
  const sectionCps = safe(() => parseSectionBoundaries(table, fib.fcPlcfSed, fib.lcbPlcfSed), []);
  const picMap = safe(() => buildPicMap(chpMap, dataStream), []);
  const listInfo = safe(() => parseListTables(table, fib), { lvlsByLsid: new Map(), lsidByIlfo: new Map() });
  return {
    chpMap,
    papMap,
    styles,
    fonts,
    sectionCps,
    picMap,
    listInfo,
    defaultChp: { halfPts: 20 }, // 10pt 기본
    defaultPap: {},
  };
}

/** CHPX 중 sprmCPicLocation(0x6A03) 을 가진 구간을 Data 스트림 그림으로 해석. */
function buildPicMap(chpMap: FcGrpprl[], dataStream?: Uint8Array): PicEntry[] {
  if (!dataStream || !dataStream.length) return [];
  const out: PicEntry[] = [];
  for (const e of chpMap) {
    const off = picLocationOf(e.grpprl);
    if (off === undefined || off === 0) continue;
    const pic = safe(() => pictureFromPicf(dataStream, off), null);
    // uri 있으면 <img>, 없어도 포맷 있으면 자리표시(EMF/WMF/TIFF).
    if (pic && (pic.uri || pic.format)) out.push({ fcFirst: e.fcFirst, fcLim: e.fcLim, pic });
  }
  return out;
}

/** grpprl 에서 sprmCPicLocation(0x6A03, 4바이트 operand) 의 Data 오프셋을 찾는다. */
function picLocationOf(grpprl: Uint8Array): number | undefined {
  if (!grpprl.length) return undefined;
  const dv = new DataView(grpprl.buffer, grpprl.byteOffset, grpprl.byteLength);
  let i = 0;
  while (i + 2 <= grpprl.length) {
    const sprm = dv.getUint16(i, true);
    const opAt = i + 2;
    const olen = operandLen(sprm, grpprl, opAt);
    if (olen <= 0 || opAt + olen > grpprl.length) break;
    if (sprm === 0x6a03 && olen >= 4) return dv.getUint32(opAt, true);
    i = opAt + olen;
  }
  return undefined;
}

/** FC 위치의 그림(있으면 data URI 등)을 반환. */
export function pictureAt(idx: DocFormatIndex, fc: number): DocPicture | undefined {
  for (const e of idx.picMap) {
    if (fc >= e.fcFirst && fc < e.fcLim) return e.pic;
  }
  return undefined;
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/** FC 의 글자속성 해석: 기본 → 문단 istd 스타일 → 직접 CHPX. */
export function chpAt(idx: DocFormatIndex, fc: number, istd: number | undefined): ChpProps {
  let base = idx.defaultChp;
  if (istd !== undefined) base = resolveStyleChp(idx.styles, istd, base);
  const e = findByFc(idx.chpMap, fc);
  if (e && e.grpprl.length) return applyChpSprms(e.grpprl, base);
  return base;
}

/** FC(문단마크) 의 문단속성 해석: 기본 → istd 스타일 → 직접 PAPX. 반환에 istd 포함. */
export function papAt(idx: DocFormatIndex, fc: number): PapProps {
  const e = findByFc(idx.papMap, fc);
  const istd = e?.istd;
  let base = idx.defaultPap;
  if (istd !== undefined) base = resolveStylePap(idx.styles, istd, base);
  let p = e && e.grpprl.length ? applyPapSprms(e.grpprl, base) : base;
  if (p.istd === undefined && istd !== undefined) p = { ...p, istd };
  return p;
}

// ───────────────────────── 표 정의(TAP: 셀 테두리/음영) ─────────────────────────

/** 한 변의 테두리. style="none" 이면 테두리 없음(투명). */
export interface CellBorder {
  style: string; // CSS border-style
  widthPt: number;
  color: string;
}

/** 한 셀의 시각 속성. */
export interface CellStyle {
  top?: CellBorder;
  left?: CellBorder;
  bottom?: CellBorder;
  right?: CellBorder;
  /** 배경색 "#rrggbb" 또는 undefined. */
  fill?: string;
  /** 가로 병합: 왼쪽 셀에 병합됨(이 셀은 렌더 생략, 왼쪽 colspan++). */
  fMerged?: boolean;
  /** 세로 병합 연속(위 셀에 병합됨, 렌더 생략, 위 rowspan++). */
  fVertMerge?: boolean;
  /** 세로 병합 시작(rowspan 의 머리). */
  fVertRestart?: boolean;
}

/** 한 행(TTP)의 표 정의. */
export interface TableDef {
  /** 열 수. */
  itcMac: number;
  /** 셀별 시각 속성(길이 = itcMac). */
  cells: CellStyle[];
}

/** brcType → CSS border-style. 0/없음 → "none"(투명). */
function brcStyle(brcType: number): string {
  switch (brcType) {
    case 0:
    case 0xff:
      return "none";
    case 6:
      return "dotted";
    case 7:
    case 8:
    case 9:
    case 22:
      return "dashed";
    case 3:
      return "double";
    default:
      return "solid"; // single/thick/hairline 등
  }
}

/** Brc80(4바이트) → CellBorder. 없으면 undefined. */
function decodeBrc80(gp: Uint8Array, off: number): CellBorder | undefined {
  if (off + 4 > gp.length) return undefined;
  const dptLineWidth = gp[off]!;
  const brcType = gp[off + 1]!;
  const ico = gp[off + 2]!;
  const style = brcStyle(brcType);
  if (style === "none" || dptLineWidth === 0) return undefined;
  return { style, widthPt: dptLineWidth / 8, color: ICO_COLORS[ico] ?? "#000000" };
}

/** Word COLORREF(cv, 0x00BBGGRR) → "#rrggbb". 상위 바이트(0xFF)=auto → undefined. */
function cvColor(v: number): string | undefined {
  if ((v & 0xff000000) !== 0) return undefined; // auto/특수
  const r = v & 0xff;
  const g = (v >> 8) & 0xff;
  const b = (v >> 16) & 0xff;
  const h = (n: number) => n.toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** grpprl 에서 특정 sprm 의 operand 시작 오프셋·길이를 찾는다. */
function findSprmOperand(gp: Uint8Array, target: number): { at: number; len: number } | undefined {
  const dv = new DataView(gp.buffer, gp.byteOffset, gp.byteLength);
  let i = 0;
  while (i + 2 <= gp.length) {
    const sprm = dv.getUint16(i, true);
    const at = i + 2;
    const olen = operandLen(sprm, gp, at);
    if (olen <= 0 || at + olen > gp.length) break;
    if (sprm === target) return { at, len: olen };
    i = at + olen;
  }
  return undefined;
}

/**
 * PAPX grpprl 에서 sprmTDefTable(0xD608) 을 파싱해 행의 셀 테두리/음영을 만든다.
 *   operand: cb(2) + itcMac(1) + rgdxaCenter[(itcMac+1)*2] + rgTc80[itcMac*20].
 *   TC80(20B): rgf(2)+unused(2)+brcTop(4)+brcLeft(4)+brcBottom(4)+brcRight(4).
 *   음영: sprmTDefTableShd(0xD612, SHD 10B 배열) 의 cvBack/cvFore.
 */
export function parseTableDef(grpprl: Uint8Array): TableDef | null {
  const def = findSprmOperand(grpprl, 0xd608);
  if (!def) return null;
  // operand: [cb(2)][itcMac(1)][rgdxaCenter][rgTc80]
  const itcMac = grpprl[def.at + 2] ?? 0;
  if (itcMac <= 0 || itcMac > 64) return null;
  const tcBase = def.at + 3 + (itcMac + 1) * 2;
  const dvg = new DataView(grpprl.buffer, grpprl.byteOffset, grpprl.byteLength);
  const cells: CellStyle[] = [];
  for (let c = 0; c < itcMac; c++) {
    const o = tcBase + c * 20;
    if (o + 20 > grpprl.length) break;
    // TC80 rgf(2B): bit0 fFirstMerged, bit1 fMerged, bit5 fVertMerge, bit6 fVertRestart.
    const rgf = dvg.getUint16(o, true);
    cells.push({
      top: decodeBrc80(grpprl, o + 4),
      left: decodeBrc80(grpprl, o + 8),
      bottom: decodeBrc80(grpprl, o + 12),
      right: decodeBrc80(grpprl, o + 16),
      fMerged: (rgf & 0x0002) !== 0,
      fVertMerge: (rgf & 0x0020) !== 0,
      fVertRestart: (rgf & 0x0040) !== 0,
    });
  }
  // 셀 음영: sprmTDefTableShd(0xD612) = SHD(10B) 배열. [len(1)][SHD×n].
  const shd = findSprmOperand(grpprl, 0xd612);
  if (shd) {
    const dv = new DataView(grpprl.buffer, grpprl.byteOffset, grpprl.byteLength);
    const cb = grpprl[shd.at] ?? 0;
    const n = Math.floor(cb / 10);
    for (let c = 0; c < n && c < cells.length; c++) {
      const o = shd.at + 1 + c * 10;
      if (o + 10 > grpprl.length) break;
      const cvFore = dv.getUint32(o, true);
      const cvBack = dv.getUint32(o + 4, true);
      const ipat = dv.getUint16(o + 8, true);
      // ipat: 0=clear(없음), 1=solid(전경색), 그외 패턴(배경색 근사).
      const fill = ipat === 1 ? cvColor(cvFore) : ipat === 0 ? cvColor(cvBack) : cvColor(cvBack) ?? cvColor(cvFore);
      if (fill) cells[c]!.fill = fill;
    }
  }
  return cells.length ? { itcMac, cells } : null;
}

/** 행끝 마크 FC 의 표 정의(없으면 null). */
export function tableDefAt(idx: DocFormatIndex, fc: number): TableDef | null {
  const e = findByFc(idx.papMap, fc);
  if (!e || !e.grpprl.length) return null;
  return parseTableDef(e.grpprl);
}

// ───────────────────────── 목록 자동번호(LST/LFO) ─────────────────────────

/** 한 목록 레벨의 번호 정의. */
export interface LvlDef {
  /** 번호 형식 코드(nfc): 0=십진, 18=①, 23=불릿, 24=가나다, 25=ㄱㄴㄷ 등. */
  nfc: number;
  /** 시작 값. */
  startAt: number;
  /** 번호 뒤 문자: 0=tab, 1=space, 2=없음. */
  follow: number;
  /** 레벨 텍스트 템플릿. 자리표시자는 코드포인트 0-8(레벨 ilvl) → " ".."". */
  template: string;
}

/** 목록 정의 모음. */
export interface ListInfo {
  /** lsid → 9개(또는 1개) 레벨 정의. */
  lvlsByLsid: Map<number, LvlDef[]>;
  /** ilfo(1-based) → lsid. */
  lsidByIlfo: Map<number, number>;
}

/** PlcfLst + PlfLfo 파싱 → 목록 정의(실패시 빈 맵). */
export function parseListTables(table: Uint8Array, fib: import("./doc-fib.js").FibInfo): ListInfo {
  const lvlsByLsid = new Map<number, LvlDef[]>();
  const lsidByIlfo = new Map<number, number>();
  try {
    const dv = new DataView(table.buffer, table.byteOffset, table.byteLength);
    // ── PlcfLst: cLst(2) + rgLstf[cLst*28] + 모든 LVL 들 순차 ──
    const fcLst = fib.fcPlcfLst;
    if (fib.lcbPlcfLst >= 2 && fcLst + 2 <= table.length) {
      const cLst = dv.getUint16(fcLst, true);
      const lstfs: { lsid: number; simple: boolean }[] = [];
      let p = fcLst + 2;
      for (let i = 0; i < cLst && p + 28 <= table.length; i++) {
        lstfs.push({ lsid: dv.getInt32(p, true), simple: (table[p + 26]! & 1) !== 0 });
        p += 28;
      }
      // LVL 들은 rgLstf 뒤에 LST 순서대로 (simple=1, 아니면 9개씩).
      let lp = p;
      for (const lstf of lstfs) {
        const nLvl = lstf.simple ? 1 : 9;
        const lvls: LvlDef[] = [];
        for (let lv = 0; lv < nLvl; lv++) {
          const parsed = parseLvl(table, dv, lp);
          if (!parsed) break;
          lvls.push(parsed.lvl);
          lp = parsed.end;
        }
        // simple 목록은 0번 레벨을 모든 레벨로 복제(ilvl 안전).
        if (lvls.length === 1) for (let k = 1; k < 9; k++) lvls.push(lvls[0]!);
        if (lvls.length) lvlsByLsid.set(lstf.lsid, lvls);
      }
    }
    // ── PlfLfo: lfoMac(4) + rgLfo[lfoMac*16] ──
    const fcLfo = fib.fcPlfLfo;
    if (fib.lcbPlfLfo >= 4 && fcLfo + 4 <= table.length) {
      const lfoMac = dv.getInt32(fcLfo, true);
      let lo = fcLfo + 4;
      for (let i = 0; i < lfoMac && lo + 16 <= table.length; i++) {
        lsidByIlfo.set(i + 1, dv.getInt32(lo, true)); // ilfo 는 1-based
        lo += 16;
      }
    }
  } catch {
    /* 목록 파싱 실패는 무시(번호 없이 렌더) */
  }
  return { lvlsByLsid, lsidByIlfo };
}

/** LVLF(28B) + grpprlPapx + grpprlChpx + xst 를 파싱. */
function parseLvl(table: Uint8Array, dv: DataView, off: number): { lvl: LvlDef; end: number } | null {
  if (off + 28 > table.length) return null;
  const startAt = dv.getInt32(off, true);
  const nfc = table[off + 4]!;
  const follow = table[off + 15]!;
  const cbChpx = table[off + 24]!;
  const cbPapx = table[off + 25]!;
  let q = off + 28 + cbPapx + cbChpx;
  if (q + 2 > table.length) return null;
  const cch = dv.getUint16(q, true);
  q += 2;
  if (q + cch * 2 > table.length) return null;
  let template = "";
  for (let k = 0; k < cch; k++) template += String.fromCharCode(dv.getUint16(q + k * 2, true));
  q += cch * 2;
  return { lvl: { nfc, startAt, follow, template }, end: q };
}
