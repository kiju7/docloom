/**
 * HWP DocInfo 스트림 해석 → 팔레트 + 문자속성(charShape) 마크 맵.
 *
 * DocInfo 는 레코드들의 모음이다. 여기서 두 종류만 본다:
 *   - HWPTAG_CHAR_SHAPE: 문자 모양 정의. property 비트필드로 굵게/기울임/밑줄/취소선 추출.
 *     레코드 등장 순서가 곧 charShapeId(0,1,2…).
 *   - HWPTAG_STYLE: 문단 스타일. 한글 이름 → styleKey. 등장 순서가 곧 styleId.
 *
 * 정확도보다 "결정성"이 중요하다(같은 비트 → 같은 마크 → 왕복 안정). 비트 의미가 다소
 * 어긋나도 왕복 모델 동치는 유지된다.
 */
import { parseRecords, HWPTAG_CHAR_SHAPE, HWPTAG_STYLE } from "./record.js";
import type { Mark } from "../model/docModel.js";
import type { Palette, PaletteEntry } from "../palette/palette.js";

/** CHAR_SHAPE property(UINT32) → 마크. (offset 46 에 위치) */
function marksFromProperty(prop: number): Mark[] {
  const marks: Mark[] = [];
  if (prop & 0x01) marks.push("italic"); // bit0 기울임
  if (prop & 0x02) marks.push("bold"); // bit1 굵게
  if ((prop >> 2) & 0x03) marks.push("underline"); // bit2-3 밑줄 종류(!=0)
  if ((prop >> 18) & 0x07) marks.push("strike"); // bit18-20 취소선 종류(!=0)
  return marks;
}

/** DocInfo → charShapeId → 마크 맵. */
export function parseCharMarksFromDocInfo(docInfo: Uint8Array): Map<number, Mark[]> {
  const map = new Map<number, Mark[]>();
  let id = 0;
  for (const rec of parseRecords(docInfo)) {
    if (rec.tag !== HWPTAG_CHAR_SHAPE) continue;
    const d = rec.data;
    if (d.length >= 50) {
      const prop = new DataView(d.buffer, d.byteOffset, d.byteLength).getUint32(46, true);
      const marks = marksFromProperty(prop);
      if (marks.length) map.set(id, marks);
    }
    id++;
  }
  return map;
}

/** WCHAR 길이접두(UINT16) 문자열을 offset 에서 읽고 다음 offset 반환. */
function readLenPrefixedWStr(dv: DataView, off: number): { text: string; next: number } {
  const len = dv.getUint16(off, true);
  let s = "";
  for (let i = 0; i < len; i++) s += String.fromCharCode(dv.getUint16(off + 2 + i * 2, true));
  return { text: s, next: off + 2 + len * 2 };
}

/** 한글 스타일명 → {styleKey, htmlTag}. (fromHwpx 와 같은 휴리스틱) */
function styleKeyFromName(name: string): { key: string; tag: PaletteEntry["htmlTag"] } | undefined {
  const n = name.replace(/\s+/g, "");
  const outline = n.match(/^개요(\d+)$/);
  if (outline) {
    const lvl = Math.min(6, Math.max(1, Number(outline[1])));
    return { key: `heading${lvl}`, tag: `h${lvl}` as PaletteEntry["htmlTag"] };
  }
  if (n === "제목" || n.toLowerCase() === "title") return { key: "title", tag: "h1" };
  if (n === "바탕글" || n === "본문" || n.toLowerCase() === "normal") return { key: "body", tag: "p" };
  return undefined;
}

function sanitizeKey(base: string, used: Set<string>): string {
  let b = base.replace(/[^A-Za-z0-9_-]/g, "_");
  if (b === "") b = "s";
  let out = b;
  let i = 1;
  while (used.has(out)) out = `${b}_${i++}`;
  used.add(out);
  return out;
}

/** DocInfo 의 STYLE 레코드 → 팔레트. docxStyleId 에는 styleId(등장 순서)를 담는다. */
export function buildPaletteFromHwp(docInfo: Uint8Array, id = "hwp"): Palette {
  const entries: PaletteEntry[] = [];
  const used = new Set<string>();
  let fallback: string | undefined;
  let styleId = 0;

  for (const rec of parseRecords(docInfo)) {
    if (rec.tag !== HWPTAG_STYLE) continue;
    const d = rec.data;
    const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
    let name = "";
    try {
      name = readLenPrefixedWStr(dv, 0).text;
    } catch {
      name = "";
    }
    const named = styleKeyFromName(name);
    let styleKey: string;
    let htmlTag: PaletteEntry["htmlTag"] = "p";
    if (named && !used.has(named.key)) {
      styleKey = named.key;
      htmlTag = named.tag;
      used.add(styleKey);
    } else {
      styleKey = sanitizeKey(name || `style${styleId}`, used);
      if (named) htmlTag = named.tag;
    }
    entries.push({ styleKey, docxStyleId: String(styleId), htmlTag });
    if (styleKey === "body") fallback = "body";
    styleId++;
  }

  if (!fallback) fallback = entries.find((e) => e.styleKey === "body")?.styleKey ?? entries[0]?.styleKey;
  if (!fallback) {
    entries.push({ styleKey: "body", docxStyleId: "0", htmlTag: "p" });
    fallback = "body";
  }
  return { id, entries, fallbackStyleKey: fallback };
}
