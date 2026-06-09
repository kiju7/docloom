/**
 * 임베디드 폰트 추출·임베딩 — PDF 안의 폰트 프로그램을 꺼내 브라우저용 @font-face 로 만든다.
 *
 * 왜 필요한가: PDF 의 임베디드 TrueType(서브셋)은 대개 (1,0) Mac cmap 만 가져 코드→글리프만
 * 알 뿐, 유니코드 cmap 이 없다. 그래서 그냥 임베드해 유니코드 텍스트로 렌더하면 브라우저가
 * 글리프를 못 찾아 □ 가 된다. 해결책: 폰트에 **(3,1) 유니코드 cmap 을 새로 주입**해, docloom 이
 * 이미 가진 유니코드 텍스트(ToUnicode 기반)와 글리프를 직접 잇는다. 그러면 그 PC 에 해당 폰트가
 * 없어도(폐쇄망 포함) 원본 글꼴 그대로 보인다. 폰트 바이트는 파일 안에 있으니 네트워크는 없다.
 *
 * 범위: FontFile2(TrueType sfnt)만 처리. CFF(FontFile3)·Type1(FontFile)은 null 반환 → 호출측이
 * 기존 대체폰트로 폴백. sfnt 는 cmap 테이블만 교체하고 나머지(glyf/loca/head…)는 그대로 둔다.
 */

import { PStream, PName, type PDict, type PdfDocument } from "./pdfObjects.js";
import { cidToUnicodeKorea1 } from "./cidUnicodeKorea1.js";

/** 폰트의 코드→유니코드/폭 등 — embedFontFace 가 글리프 매핑을 만드는 데 쓰는 정보. */
export interface FontMapInfo {
  toUnicode?: Map<number, string>;
  unicodeCodes: boolean;
  twoByte: boolean;
  widths: Map<number, number>;
  defaultWidth: number;
  /** ToUnicode 없는 Identity-H CID 폰트의 CIDSystemInfo /Ordering("Korea1" 지원). */
  cidOrdering?: string;
}

/** 빅엔디안 읽기 헬퍼. */
const u16 = (b: Uint8Array, o: number): number => (b[o]! << 8) | b[o + 1]!;
const u32 = (b: Uint8Array, o: number): number => b[o]! * 0x1000000 + (b[o + 1]! << 16) + (b[o + 2]! << 8) + b[o + 3]!;

interface SfntTable { tag: string; checksum: number; offset: number; length: number; }

/** sfnt 테이블 디렉터리 파싱. 유효한 TrueType/OpenType 가 아니면 null. */
function readTables(b: Uint8Array): { version: number; tables: SfntTable[] } | null {
  if (b.length < 12) return null;
  const version = u32(b, 0);
  // 0x00010000(TrueType), 'true', 'OTTO'(CFF), 'ttcf'(컬렉션—미지원)
  if (version !== 0x00010000 && version !== 0x74727565 && version !== 0x4f54544f) return null;
  const numTables = u16(b, 4);
  if (numTables === 0 || numTables > 64) return null;
  const tables: SfntTable[] = [];
  for (let i = 0; i < numTables; i++) {
    const o = 12 + i * 16;
    if (o + 16 > b.length) return null;
    tables.push({
      tag: String.fromCharCode(b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!),
      checksum: u32(b, o + 4),
      offset: u32(b, o + 8),
      length: u32(b, o + 12),
    });
  }
  return { version, tables };
}

/** cmap 서브테이블(format 0/4/6) → 코드→GID. 가장 풍부한 서브테이블을 고른다. */
function parseCmapCodeToGid(b: Uint8Array, cmapOff: number): Map<number, number> {
  const map = new Map<number, number>();
  if (cmapOff + 4 > b.length) return map;
  const nSub = u16(b, cmapOff + 2);
  // 후보 서브테이블 오프셋 수집 후, 가장 많은 매핑을 주는 것을 쓴다.
  let best = new Map<number, number>();
  for (let i = 0; i < nSub; i++) {
    const recOff = cmapOff + 4 + i * 8;
    if (recOff + 8 > b.length) break;
    const subOff = cmapOff + u32(b, recOff + 4);
    if (subOff + 4 > b.length) continue;
    const fmt = u16(b, subOff);
    const cur = new Map<number, number>();
    try {
      if (fmt === 0) {
        for (let c = 0; c < 256; c++) { const g = b[subOff + 6 + c]!; if (g) cur.set(c, g); }
      } else if (fmt === 6) {
        const first = u16(b, subOff + 6), cnt = u16(b, subOff + 8);
        for (let k = 0; k < cnt; k++) { const g = u16(b, subOff + 10 + k * 2); if (g) cur.set(first + k, g); }
      } else if (fmt === 4) {
        const segX2 = u16(b, subOff + 6), segs = segX2 / 2;
        const endO = subOff + 14, startO = endO + segX2 + 2, deltaO = startO + segX2, rangeO = deltaO + segX2;
        for (let s = 0; s < segs; s++) {
          const end = u16(b, endO + s * 2), start = u16(b, startO + s * 2);
          const delta = u16(b, deltaO + s * 2), ro = u16(b, rangeO + s * 2);
          for (let c = start; c <= end && c !== 0xffff; c++) {
            let g: number;
            if (ro === 0) g = (c + delta) & 0xffff;
            else {
              const gi = rangeO + s * 2 + ro + (c - start) * 2;
              if (gi + 2 > b.length) continue;
              g = u16(b, gi); if (g !== 0) g = (g + delta) & 0xffff;
            }
            if (g) cur.set(c, g);
          }
        }
      }
    } catch { /* 깨진 서브테이블 무시 */ }
    if (cur.size > best.size) best = cur;
  }
  return best.size ? best : map;
}

/** 유니코드(BMP)→GID 쌍들로 (3,1) format 4 cmap 테이블 바이트 생성(글자당 1세그먼트, 단순·정확). */
function makeCmapFormat4(uToG: Map<number, number>): Uint8Array {
  // BMP 만, 코드포인트 오름차순.
  const pairs = [...uToG.entries()].filter(([u]) => u > 0 && u <= 0xfffe).sort((a, b) => a[0] - b[0]);
  const segCount = pairs.length + 1; // + 마지막 0xFFFF 종료 세그먼트
  const segX2 = segCount * 2;
  // format4 본문: 14B 헤더 + end[]+pad2+start[]+delta[]+range[]
  const subLen = 14 + segX2 + 2 + segX2 + segX2 + segX2;
  const out = new Uint8Array(4 + 8 + subLen); // cmap 헤더(4) + 1 레코드(8) + 서브테이블
  const dv = new DataView(out.buffer);
  let p = 0;
  dv.setUint16(p, 0); p += 2;        // version
  dv.setUint16(p, 1); p += 2;        // numTables = 1
  dv.setUint16(p, 3); p += 2;        // platformID = 3 (Windows)
  dv.setUint16(p, 1); p += 2;        // encodingID = 1 (Unicode BMP)
  dv.setUint32(p, 12); p += 4;       // offset to subtable (4+8)
  // subtable format 4
  const sub = p;
  dv.setUint16(p, 4); p += 2;        // format
  dv.setUint16(p, subLen); p += 2;   // length
  dv.setUint16(p, 0); p += 2;        // language
  dv.setUint16(p, segX2); p += 2;    // segCountX2
  let sr = 2, es = 0; while (sr * 2 <= segX2) { sr *= 2; es++; } sr = Math.min(sr, segX2);
  dv.setUint16(p, sr); p += 2;       // searchRange
  dv.setUint16(p, es); p += 2;       // entrySelector
  dv.setUint16(p, segX2 - sr); p += 2; // rangeShift
  const endP = p, startP = endP + segX2 + 2, deltaP = startP + segX2, rangeP = deltaP + segX2;
  for (let i = 0; i < pairs.length; i++) {
    const [u, g] = pairs[i]!;
    dv.setUint16(endP + i * 2, u);
    dv.setUint16(startP + i * 2, u);
    dv.setUint16(deltaP + i * 2, (g - u) & 0xffff); // idDelta: 코드+delta=GID
    dv.setUint16(rangeP + i * 2, 0);
  }
  // 종료 세그먼트 0xFFFF
  const last = pairs.length;
  dv.setUint16(endP + last * 2, 0xffff);
  dv.setUint16(startP + last * 2, 0xffff);
  dv.setUint16(deltaP + last * 2, 1);
  dv.setUint16(rangeP + last * 2, 0);
  void sub;
  return out;
}

/** 테이블 체크섬(4바이트 합, 32bit wrap). */
function checksum(b: Uint8Array, off: number, len: number): number {
  let sum = 0;
  for (let i = 0; i < len; i += 4) {
    const v = (b[off + i]! << 24) | ((b[off + i + 1] ?? 0) << 16) | ((b[off + i + 2] ?? 0) << 8) | (b[off + i + 3] ?? 0);
    sum = (sum + (v >>> 0)) >>> 0;
  }
  return sum >>> 0;
}

const pad4 = (n: number): number => (n + 3) & ~3;

/** 테이블 묶음 → 완결 sfnt 바이트(디렉터리 정렬·4바이트 정렬·체크섬·head 보정). */
function buildSfnt(version: number, parts: { tag: string; data: Uint8Array }[]): Uint8Array {
  parts = [...parts].sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0)); // 디렉터리는 태그 오름차순
  const numTables = parts.length;
  const dirSize = 12 + numTables * 16;
  let total = dirSize;
  const layout = parts.map((pt) => { const off = total; total += pad4(pt.data.length); return { ...pt, off }; });

  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, version);
  dv.setUint16(4, numTables);
  let sr = 1, es = 0; while (sr * 2 <= numTables) { sr *= 2; es++; }
  sr *= 16;
  dv.setUint16(6, sr);
  dv.setUint16(8, es);
  dv.setUint16(10, numTables * 16 - sr);
  let headOff = -1;
  for (let i = 0; i < layout.length; i++) {
    const e = layout[i]!;
    out.set(e.data, e.off);
    const recO = 12 + i * 16;
    out[recO] = e.tag.charCodeAt(0); out[recO + 1] = e.tag.charCodeAt(1);
    out[recO + 2] = e.tag.charCodeAt(2); out[recO + 3] = e.tag.charCodeAt(3);
    dv.setUint32(recO + 4, checksum(out, e.off, e.data.length));
    dv.setUint32(recO + 8, e.off);
    dv.setUint32(recO + 12, e.data.length); // 패딩 전 실제 길이
    if (e.tag === "head") headOff = e.off;
  }
  // head.checkSumAdjustment: 0xB1B0AFBA - 전체 합
  if (headOff >= 0 && headOff + 12 <= out.length) {
    dv.setUint32(headOff + 8, 0);
    dv.setUint32(headOff + 8, (0xb1b0afba - checksum(out, 0, out.length)) >>> 0);
  }
  return out;
}

/** head.unitsPerEm + hhea.ascender/descender 읽기(OS/2 합성용). 없으면 기본값. */
function readMetrics(src: Uint8Array, tables: SfntTable[]): { em: number; asc: number; desc: number } {
  let em = 1000, asc = 800, desc = -200;
  const head = tables.find((t) => t.tag === "head");
  if (head && head.offset + 20 <= src.length) em = u16(src, head.offset + 18) || 1000;
  const hhea = tables.find((t) => t.tag === "hhea");
  if (hhea && hhea.offset + 8 <= src.length) {
    const s16 = (o: number) => { const v = u16(src, o); return v >= 0x8000 ? v - 0x10000 : v; };
    asc = s16(hhea.offset + 4); desc = s16(hhea.offset + 6);
  }
  return { em, asc, desc };
}

/** 최소 OS/2(v4, 96B). PDF 임베디드 서브셋엔 빠지지만 브라우저(OTS)는 필수로 요구한다. */
function synthOS2(em: number, asc: number, desc: number): Uint8Array {
  const b = new Uint8Array(96); const dv = new DataView(b.buffer);
  const i16 = (o: number, v: number) => dv.setInt16(o, v | 0);
  const u = (o: number, v: number) => dv.setUint16(o, v & 0xffff);
  u(0, 4);                       // version 4
  i16(2, Math.round(em * 0.5));  // xAvgCharWidth
  u(4, 400);                     // usWeightClass = Regular
  u(6, 5);                       // usWidthClass = Medium
  u(8, 0);                       // fsType = installable
  i16(10, Math.round(em * 0.65)); i16(12, Math.round(em * 0.6)); i16(14, 0); i16(16, Math.round(em * 0.075)); // subscript
  i16(18, Math.round(em * 0.65)); i16(20, Math.round(em * 0.6)); i16(22, 0); i16(24, Math.round(em * 0.48)); // superscript
  i16(26, Math.round(em * 0.05)); i16(28, Math.round(em * 0.26)); // strikeout size/pos
  i16(30, 0);                    // sFamilyClass
  // panose[10] = 0 (이미 0)
  // ulUnicodeRange1..4 = 0
  b.set([0x44, 0x4c, 0x4d, 0x20], 58); // achVendID "DLM "
  u(62, 0x40);                   // fsSelection = REGULAR
  u(64, 0x20);                   // usFirstCharIndex
  u(66, 0xffff);                 // usLastCharIndex
  i16(68, asc); i16(70, desc); i16(72, 0); // sTypo Ascender/Descender/LineGap
  u(74, Math.abs(asc)); u(76, Math.abs(desc)); // usWin Ascent/Descent
  // ulCodePageRange1/2 = 0
  i16(86, 0); i16(88, Math.round(asc * 0.7)); // sxHeight, sCapHeight
  u(90, 0); u(92, 0x20); u(94, 0); // usDefaultChar, usBreakChar, usMaxContext
  return b;
}

/** 최소 post(v3.0, 32B) — 글리프 이름 없음. OTS 가 요구하는 필수 테이블. */
function synthPost(): Uint8Array {
  const b = new Uint8Array(32); const dv = new DataView(b.buffer);
  dv.setUint32(0, 0x00030000); // version 3.0
  return b;
}

/** sfnt 의 cmap 테이블을 newCmap 으로 교체(없으면 추가)해 새 폰트 바이트를 만든다.
 *  + 브라우저(OTS) 필수인데 PDF 서브셋엔 흔히 빠지는 OS/2·post 를 없으면 합성해 넣는다. */
function rebuildWithCmap(src: Uint8Array, version: number, tables: SfntTable[], newCmap: Uint8Array): Uint8Array {
  const parts: { tag: string; data: Uint8Array }[] = [];
  let hasOS2 = false, hasPost = false;
  for (const t of tables) {
    if (t.tag === "cmap") continue;
    if (t.tag === "OS/2") hasOS2 = true;
    if (t.tag === "post") hasPost = true;
    parts.push({ tag: t.tag, data: src.subarray(t.offset, t.offset + t.length) });
  }
  parts.push({ tag: "cmap", data: newCmap });
  if (!hasOS2) { const m = readMetrics(src, tables); parts.push({ tag: "OS/2", data: synthOS2(m.em, m.asc, m.desc) }); }
  if (!hasPost) parts.push({ tag: "post", data: synthPost() });
  return buildSfnt(version, parts);
}

/** 유효한 sfnt(TrueType/OpenType)면 그 안의 cmap 을 (3,1) 유니코드 cmap 으로 교체. 아니면 null. */
export function injectUnicodeCmap(sfnt: Uint8Array, uToG: Map<number, number>): Uint8Array | null {
  const dir = readTables(sfnt);
  if (!dir) return null;
  if (uToG.size === 0) return null;
  return rebuildWithCmap(sfnt, dir.version, dir.tables, makeCmapFormat4(uToG));
}

/** CIDToGIDMap → cid→gid 함수. Identity(이름/없음)면 gid=cid, 스트림이면 2바이트 룩업. */
function cidToGidResolver(doc: PdfDocument, descendant: PDict | undefined): (cid: number) => number {
  const m = descendant ? doc.resolve(doc.get(descendant, "CIDToGIDMap")) : null;
  if (m instanceof PStream) {
    const b = doc.decodeStream(m);
    return (cid) => { const o = cid * 2; return o + 1 < b.length ? (b[o]! << 8) | b[o + 1]! : 0; };
  }
  return (cid) => cid; // Identity
}

/** FontMapInfo → 코드→유니코드(렌더의 codeToText 와 같은 규칙). */
function makeCodeToUni(fm: FontMapInfo): (code: number) => string {
  return (code: number): string => {
    if (fm.toUnicode) { const s = fm.toUnicode.get(code); if (s !== undefined) return s; }
    if (fm.unicodeCodes) return code > 0 ? String.fromCharCode(code) : "";
    // ToUnicode 없는 Korea1 Identity-H CID 폰트: 표준 CID→유니코드 로 글리프와 잇는다.
    if (fm.cidOrdering === "Korea1") {
      const u = cidToUnicodeKorea1(code);
      if (u !== undefined) return u > 0 ? String.fromCodePoint(u) : "";
    }
    if (fm.twoByte) return "";
    if (code >= 0x20 && code !== 0x7f) return String.fromCharCode(code);
    return "";
  };
}

/** 코드→GID 맵 구성: 단순폰트는 임베디드 cmap, CID 는 CIDToGIDMap, bare CFF 는 CFF 인코딩. */
function buildCodeToGid(
  doc: PdfDocument, raw: Uint8Array, kind: "tt" | "ff3", isType0: boolean, descendant: PDict | undefined, fm: FontMapInfo,
): Map<number, number> | null {
  if (isType0) {
    // CID 폰트: 코드=CID(Identity-H/V 가정). gid 는 CIDFontType2=CIDToGIDMap, CIDFontType0(bare CFF)=CFF charset.
    let resolve: (cid: number) => number;
    if (kind === "ff3" && !readTables(raw)) {
      const inv = cffCidToGid(raw);
      if (!inv) return null;
      resolve = (cid) => inv.get(cid) ?? 0;
    } else {
      resolve = cidToGidResolver(doc, descendant);
    }
    const codes = new Set<number>([...(fm.toUnicode?.keys() ?? []), ...fm.widths.keys()]);
    const m = new Map<number, number>();
    for (const code of codes) m.set(code, resolve(code));
    return m.size ? m : null;
  }
  if (kind === "tt" || readTables(raw)) {
    // 단순 sfnt(TrueType/OpenType): 내장 cmap 이 코드→GID.
    const dir = readTables(raw); if (!dir) return null;
    const cmapT = dir.tables.find((t) => t.tag === "cmap"); if (!cmapT) return null;
    const m = parseCmapCodeToGid(raw, cmapT.offset);
    return m.size ? m : null;
  }
  // 단순 bare CFF: CFF 인코딩(코드→GID).
  return parseCFFEncoding(raw);
}

/**
 * 폰트 딕셔너리 → @font-face family. 단순/CID, TrueType(FontFile2)/OpenType·CFF(FontFile3)를 모두 처리.
 * Type1(FontFile)·매핑 불가는 null → 호출측이 대체폰트로 폴백. 폰트당 1회 변환·캐시.
 */
export function embedFontFace(doc: PdfDocument, fontDict: PDict, fm: FontMapInfo): string | null {
  const subtype = doc.get(fontDict, "Subtype");
  const isType0 = subtype instanceof PName && subtype.name === "Type0";
  let descriptor: PDict | undefined;
  let descendant: PDict | undefined;
  if (isType0) {
    const descs = doc.get(fontDict, "DescendantFonts");
    descendant = doc.getDict(Array.isArray(descs) ? (descs[0] ?? null) : descs) ?? undefined;
    descriptor = descendant ? doc.getDict(doc.get(descendant, "FontDescriptor")) : undefined;
  } else {
    descriptor = doc.getDict(doc.get(fontDict, "FontDescriptor"));
  }
  if (!descriptor) return null;
  const ff2 = doc.get(descriptor, "FontFile2"); // TrueType sfnt
  const ff3 = doc.get(descriptor, "FontFile3"); // OpenType sfnt 또는 bare CFF
  const stream = ff2 instanceof PStream ? ff2 : ff3 instanceof PStream ? ff3 : null;
  if (!stream) return null; // FontFile(Type1) 등 → 폴백
  const cached = doc.fontEmbedCache.get(stream);
  if (cached !== undefined) return cached;

  let family: string | null = null;
  try {
    const raw = doc.decodeStream(stream);
    const kind: "tt" | "ff3" = ff2 instanceof PStream ? "tt" : "ff3";
    const c2g = buildCodeToGid(doc, raw, kind, isType0, descendant, fm);
    if (c2g && c2g.size) {
      const codeToUni = makeCodeToUni(fm);
      const uToG = new Map<number, number>();
      for (const [code, gid] of c2g) {
        if (!gid) continue;
        const s = codeToUni(code);
        if (s.length !== 1) continue; // 합자 등 다중문자는 단순 cmap 매핑 불가 → 생략
        const u = s.codePointAt(0)!;
        if (u > 0 && u <= 0xfffe) uToG.set(u, gid);
      }
      if (uToG.size) {
        // sfnt 면 cmap 주입, bare CFF 면 OTF 로 감싼 뒤 cmap 주입.
        const sfnt = readTables(raw) ? injectUnicodeCmap(raw, uToG) : wrapCFFtoOTF(raw, uToG, c2g, fm);
        if (sfnt) {
          family = "dlf" + doc.fontFaces.size;
          const uri = "data:font/ttf;base64," + toBase64(sfnt);
          doc.fontFaces.set(family, `@font-face{font-family:"${family}";src:url(${uri});}`);
        }
      }
    }
  } catch { family = null; }
  doc.fontEmbedCache.set(stream, family);
  return family;
}

// ── bare CFF(FontFile3 Type1C/CIDFontType0C) → OTF 래핑 ──────────────────────
// 브라우저는 bare CFF 를 못 읽으므로 'OTTO' sfnt 로 감싸고(필수 테이블 합성) (3,1) cmap 을 단다.

interface CFFInfo { numGlyphs: number; unitsPerEm: number; isCID: boolean; charsetOff: number; encodingOff: number; }

/** CFF INDEX(count+offSize+offsets+data) → 항목 [start,end] 배열과 다음 위치. */
function readCFFIndex(b: Uint8Array, pos: number): { items: [number, number][]; end: number } {
  if (pos + 2 > b.length) return { items: [], end: pos };
  const count = (b[pos]! << 8) | b[pos + 1]!; pos += 2;
  if (count === 0) return { items: [], end: pos };
  const offSize = b[pos++]!;
  const readOff = (i: number): number => { let v = 0; for (let k = 0; k < offSize; k++) v = (v << 8) | b[pos + i * offSize + k]!; return v; };
  const offBase = pos + (count + 1) * offSize - 1;
  const items: [number, number][] = [];
  for (let i = 0; i < count; i++) items.push([offBase + readOff(i), offBase + readOff(i + 1)]);
  return { items, end: offBase + readOff(count) };
}

/** CFF DICT → operator(12·xx 는 1200+xx) → operand[]. */
function parseCFFDict(b: Uint8Array, start: number, end: number): Map<number, number[]> {
  const d = new Map<number, number[]>();
  let ops: number[] = [];
  let i = start;
  while (i < end) {
    const b0 = b[i]!;
    if (b0 <= 21) {
      let op = b0; i++;
      if (b0 === 12) { op = 1200 + b[i]!; i++; }
      d.set(op, ops); ops = [];
    } else if (b0 === 28) { ops.push((((b[i + 1]! << 8) | b[i + 2]!) << 16) >> 16); i += 3; }
    else if (b0 === 29) { ops.push((b[i + 1]! << 24) | (b[i + 2]! << 16) | (b[i + 3]! << 8) | b[i + 4]!); i += 5; }
    else if (b0 === 30) { // real
      i++; let s = ""; let done = false;
      while (i < end && !done) {
        const byte = b[i++]!;
        for (const nib of [byte >> 4, byte & 15]) {
          if (nib <= 9) s += nib; else if (nib === 0xa) s += "."; else if (nib === 0xb) s += "E";
          else if (nib === 0xc) s += "E-"; else if (nib === 0xe) s += "-"; else if (nib === 0xf) { done = true; break; }
        }
      }
      ops.push(parseFloat(s) || 0);
    }
    else if (b0 >= 32 && b0 <= 246) { ops.push(b0 - 139); i++; }
    else if (b0 >= 247 && b0 <= 250) { ops.push((b0 - 247) * 256 + b[i + 1]! + 108); i += 2; }
    else if (b0 >= 251 && b0 <= 254) { ops.push(-(b0 - 251) * 256 - b[i + 1]! - 108); i += 2; }
    else i++;
  }
  return d;
}

/** bare CFF 의 Top DICT 핵심값. 파싱 실패면 null. */
function parseCFFTop(b: Uint8Array): CFFInfo | null {
  if (b.length < 4 || b[0] !== 1) return null; // major version 1
  const hdrSize = b[2]!;
  let pos = hdrSize;
  pos = readCFFIndex(b, pos).end;          // Name INDEX
  const topIdx = readCFFIndex(b, pos);     // Top DICT INDEX
  if (!topIdx.items.length) return null;
  const [ts, te] = topIdx.items[0]!;
  const dict = parseCFFDict(b, ts, te);
  const charStringsOff = dict.get(17)?.[0] ?? 0;
  if (!charStringsOff) return null;
  const fm = dict.get(1207); // FontMatrix
  const unitsPerEm = fm && fm[0] ? Math.round(1 / fm[0]) : 1000;
  return {
    numGlyphs: readCFFIndex(b, charStringsOff).items.length,
    unitsPerEm: unitsPerEm || 1000,
    isCID: dict.has(1230), // ROS
    charsetOff: dict.get(15)?.[0] ?? 0,
    encodingOff: dict.get(16)?.[0] ?? 0,
  };
}

/** charset(format 0/1/2) → GID→SID/CID 배열(gid0=.notdef=0). 미리정의(0/1/2)면 null. */
function parseCFFCharset(b: Uint8Array, off: number, numGlyphs: number): number[] | null {
  if (off === 0 || off === 1 || off === 2) return null;
  const sids = new Array<number>(numGlyphs).fill(0);
  let pos = off; const fmt = b[pos++]!; let gid = 1;
  if (fmt === 0) { while (gid < numGlyphs) { sids[gid++] = (b[pos]! << 8) | b[pos + 1]!; pos += 2; } }
  else if (fmt === 1 || fmt === 2) {
    while (gid < numGlyphs) {
      const first = (b[pos]! << 8) | b[pos + 1]!; pos += 2;
      const nLeft = fmt === 1 ? b[pos++]! : ((b[pos]! << 8) | b[pos + 1]!); if (fmt === 2) pos += 2;
      for (let k = 0; k <= nLeft && gid < numGlyphs; k++) sids[gid++] = first + k;
    }
  } else return null;
  return sids;
}

/** CID-keyed CFF → CID→GID(charset 역매핑). 비CID면 null. */
function cffCidToGid(b: Uint8Array): Map<number, number> | null {
  const info = parseCFFTop(b);
  if (!info || !info.isCID) return null;
  const g2c = parseCFFCharset(b, info.charsetOff, info.numGlyphs);
  const m = new Map<number, number>();
  if (g2c) { for (let gid = 0; gid < g2c.length; gid++) m.set(g2c[gid]!, gid); m.set(0, 0); }
  else for (let gid = 0; gid < info.numGlyphs; gid++) m.set(gid, gid); // identity charset
  return m;
}

/** 단순 bare CFF 의 Encoding(format 0/1) → 코드→GID. 미리정의/CID면 null(폴백). */
function parseCFFEncoding(b: Uint8Array): Map<number, number> | null {
  const info = parseCFFTop(b);
  if (!info || info.isCID) return null;
  const off = info.encodingOff;
  if (off === 0 || off === 1) return null; // Standard/Expert 미리정의 → 폴백
  const m = new Map<number, number>();
  let pos = off; const fmt = b[pos++]! & 0x7f;
  if (fmt === 0) { const n = b[pos++]!; for (let i = 1; i <= n; i++) m.set(b[pos++]!, i); }
  else if (fmt === 1) { const nR = b[pos++]!; let gid = 1; for (let r = 0; r < nR; r++) { const first = b[pos++]!, nLeft = b[pos++]!; for (let k = 0; k <= nLeft; k++) m.set(first + k, gid++); } }
  else return null;
  return m.size ? m : null;
}

// sfnt 필수 테이블 생성기 (CFF OTF 래핑용) ----------------------------------
function makeHead(upm: number): Uint8Array {
  const b = new Uint8Array(54); const d = new DataView(b.buffer);
  d.setUint32(0, 0x00010000); d.setUint32(4, 0x00010000); /* 8: checkSumAdjustment 나중 */
  d.setUint32(12, 0x5f0f3cf5); d.setUint16(16, 0x000b); d.setUint16(18, upm);
  d.setInt16(36, 0); d.setInt16(38, -Math.round(upm * 0.2)); d.setInt16(40, upm); d.setInt16(42, Math.round(upm * 0.8));
  d.setInt16(50, 0); d.setInt16(52, 0); d.setInt16(48, 2); d.setUint16(46, 8);
  return b;
}
function makeMaxpCFF(numGlyphs: number): Uint8Array {
  const b = new Uint8Array(6); const d = new DataView(b.buffer);
  d.setUint32(0, 0x00005000); d.setUint16(4, numGlyphs); return b;
}
function makeHheaHmtx(adv: number[], upm: number): { hhea: Uint8Array; hmtx: Uint8Array } {
  const n = adv.length; let maxAdv = 0; for (const a of adv) if (a > maxAdv) maxAdv = a;
  const hhea = new Uint8Array(36); const d = new DataView(hhea.buffer);
  d.setUint32(0, 0x00010000); d.setInt16(4, Math.round(upm * 0.8)); d.setInt16(6, -Math.round(upm * 0.2));
  d.setInt16(8, 0); d.setUint16(10, maxAdv); d.setInt16(16, maxAdv); d.setInt16(18, 1); d.setUint16(34, n);
  const hmtx = new Uint8Array(n * 4); const hd = new DataView(hmtx.buffer);
  for (let i = 0; i < n; i++) hd.setUint16(i * 4, adv[i]! & 0xffff);
  return { hhea, hmtx };
}
function makeOS2(upm: number): Uint8Array {
  const b = new Uint8Array(96); const d = new DataView(b.buffer);
  d.setUint16(0, 4); d.setInt16(2, Math.round(upm * 0.5)); d.setUint16(4, 400); d.setUint16(6, 5);
  for (let i = 0; i < 4; i++) b[58 + i] = "DLfm".charCodeAt(i);
  d.setUint16(62, 0x40); d.setUint16(64, 0x20); d.setUint16(66, 0xffff);
  d.setInt16(68, Math.round(upm * 0.8)); d.setInt16(70, -Math.round(upm * 0.2)); d.setInt16(72, 0);
  d.setUint16(74, Math.round(upm * 0.8)); d.setUint16(76, Math.round(upm * 0.2));
  d.setUint32(78, 1); d.setInt16(86, Math.round(upm * 0.5)); d.setInt16(88, Math.round(upm * 0.7)); d.setUint16(92, 0x20);
  return b;
}
function makePost(): Uint8Array { const b = new Uint8Array(32); new DataView(b.buffer).setUint32(0, 0x00030000); return b; }
/** 최소 name 테이블 — 합성 family 이름(플랫폼 3,1 / Mac 0,0) 각 nameID 1·2·4·6. */
function makeName(): Uint8Array {
  const ids = [1, 2, 4, 6]; const valW = "DLFont", valSub = "Regular";
  const recs: { p: number; e: number; l: number; id: number; s: Uint8Array }[] = [];
  for (const id of ids) {
    const text = id === 2 ? valSub : valW;
    const utf16 = new Uint8Array(text.length * 2); for (let i = 0; i < text.length; i++) utf16[i * 2 + 1] = text.charCodeAt(i);
    recs.push({ p: 3, e: 1, l: 0x409, id, s: utf16 });
    const ascii = new Uint8Array(text.length); for (let i = 0; i < text.length; i++) ascii[i] = text.charCodeAt(i);
    recs.push({ p: 1, e: 0, l: 0, id, s: ascii });
  }
  const count = recs.length, headerLen = 6 + count * 12;
  let strLen = 0; for (const r of recs) strLen += r.s.length;
  const b = new Uint8Array(headerLen + strLen); const d = new DataView(b.buffer);
  d.setUint16(0, 0); d.setUint16(2, count); d.setUint16(4, headerLen);
  let so = 0;
  for (let i = 0; i < count; i++) {
    const r = recs[i]!, o = 6 + i * 12;
    d.setUint16(o, r.p); d.setUint16(o + 2, r.e); d.setUint16(o + 4, r.l); d.setUint16(o + 6, r.id);
    d.setUint16(o + 8, r.s.length); d.setUint16(o + 10, so);
    b.set(r.s, headerLen + so); so += r.s.length;
  }
  return b;
}

/** bare CFF → OTF(sfnt) 래핑 후 (3,1) cmap 주입. 폭은 PDF Widths 에서 hmtx 합성. */
export function wrapCFFtoOTF(cff: Uint8Array, uToG: Map<number, number>, c2g: Map<number, number>, fm: FontMapInfo): Uint8Array | null {
  const info = parseCFFTop(cff);
  if (!info || !info.numGlyphs) return null;
  const upm = info.unitsPerEm, n = info.numGlyphs;
  // gid→advance(폰트단위): PDF Widths(1000단위 글리프공간)를 upm 으로 환산. 없으면 0.5em.
  const adv = new Array<number>(n).fill(Math.round(upm * 0.5));
  for (const [code, gid] of c2g) {
    if (gid >= 0 && gid < n) { const w = fm.widths.get(code); if (w !== undefined) adv[gid] = Math.max(0, Math.round((w / 1000) * upm)); }
  }
  const { hhea, hmtx } = makeHheaHmtx(adv, upm);
  return buildSfnt(0x4f54544f, [
    { tag: "CFF ", data: cff },
    { tag: "cmap", data: makeCmapFormat4(uToG) },
    { tag: "head", data: makeHead(upm) },
    { tag: "hhea", data: hhea },
    { tag: "hmtx", data: hmtx },
    { tag: "maxp", data: makeMaxpCFF(n) },
    { tag: "name", data: makeName() },
    { tag: "OS/2", data: makeOS2(upm) },
    { tag: "post", data: makePost() },
  ]);
}

/** Uint8Array → base64(브라우저 atob 호환). Node/브라우저 양쪽 동작. */
export function toBase64(b: Uint8Array): string {
  let s = "";
  const CH = 0x8000;
  for (let i = 0; i < b.length; i += CH) s += String.fromCharCode(...b.subarray(i, i + CH));
  // btoa 가 있으면(브라우저/번들), 없으면 Buffer(Node).
  return typeof btoa === "function" ? btoa(s) : Buffer.from(b).toString("base64");
}
