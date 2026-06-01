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

/** 폰트의 코드→유니코드/폭 등 — embedFontFace 가 글리프 매핑을 만드는 데 쓰는 정보. */
export interface FontMapInfo {
  toUnicode?: Map<number, string>;
  unicodeCodes: boolean;
  twoByte: boolean;
  widths: Map<number, number>;
  defaultWidth: number;
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

/** sfnt 의 cmap 테이블을 newCmap 으로 교체(없으면 추가)해 새 폰트 바이트를 만든다. */
function rebuildWithCmap(src: Uint8Array, version: number, tables: SfntTable[], newCmap: Uint8Array): Uint8Array {
  const parts: { tag: string; data: Uint8Array }[] = [];
  for (const t of tables) {
    if (t.tag === "cmap") continue;
    parts.push({ tag: t.tag, data: src.subarray(t.offset, t.offset + t.length) });
  }
  parts.push({ tag: "cmap", data: newCmap });
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
    // CID 폰트: 코드=CID(Identity-H/V 가정), gid 는 CIDToGIDMap. 등장 코드는 ToUnicode·W 키에서.
    const c2gid = cidToGidResolver(doc, descendant);
    const codes = new Set<number>([...(fm.toUnicode?.keys() ?? []), ...fm.widths.keys()]);
    const m = new Map<number, number>();
    for (const code of codes) m.set(code, c2gid(code));
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

// ── bare CFF(FontFile3 Type1C/CIDFontType0C) 처리 ────────────────────────────
// 임시 스텁(Task 4 에서 구현). 현재는 bare CFF 를 임베드 안 하고 대체폰트로 폴백한다.

/** 단순 bare CFF 의 코드→GID(인코딩). 미구현 → null(폴백). */
function parseCFFEncoding(_cff: Uint8Array): Map<number, number> | null {
  return null;
}

/** bare CFF → OTF(sfnt) 래핑 후 (3,1) cmap 주입. 미구현 → null(폴백). */
function wrapCFFtoOTF(_cff: Uint8Array, _uToG: Map<number, number>, _c2g: Map<number, number>, _fm: FontMapInfo): Uint8Array | null {
  return null;
}

/** Uint8Array → base64(브라우저 atob 호환). Node/브라우저 양쪽 동작. */
export function toBase64(b: Uint8Array): string {
  let s = "";
  const CH = 0x8000;
  for (let i = 0; i < b.length; i += CH) s += String.fromCharCode(...b.subarray(i, i + CH));
  // btoa 가 있으면(브라우저/번들), 없으면 Buffer(Node).
  return typeof btoa === "function" ? btoa(s) : Buffer.from(b).toString("base64");
}
