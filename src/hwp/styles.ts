/**
 * HWP DocInfo 서식 테이블 파서 (미리보기 충실도용).
 *
 * 미리보기에서 글자 크기·색·정렬·용지를 원본처럼 보이게 하려면 DocInfo 의 서식 정의를
 * 읽어야 한다. 본 모듈은 표시에 필요한 최소 필드만 뽑는다(왕복용 아님).
 *   FACE_NAME(19)  → 글꼴 이름
 *   CHAR_SHAPE(21) → 글자 크기(base@42 /100 pt)·색(@52 RGB)·굵게/기울임/밑줄/취소선(@46 property)
 *   PARA_SHAPE(25) → 정렬(property1 bit2-4)
 * 등장 순서가 곧 id(0,1,2…).
 */
import { parseRecords, HWPTAG_FACE_NAME, HWPTAG_CHAR_SHAPE, HWPTAG_PARA_SHAPE } from "./record.js";

const HWPTAG_BORDER_FILL = 0x10 + 4; // 20

export interface HwpCharShape {
  sizePt: number;
  color?: string; // #rrggbb (검정/auto 면 생략)
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  faceId: number; // 한글 글꼴 face id
}

export type HwpAlign = "left" | "right" | "center" | "justify";

export interface HwpBorder {
  width: number; // px (0 = 없음)
  color: string;
}
export interface HwpBorderFill {
  left: HwpBorder;
  right: HwpBorder;
  top: HwpBorder;
  bottom: HwpBorder;
  bg?: string;
}

export interface HwpStyles {
  faces: string[];
  charShapes: HwpCharShape[];
  paraShapes: HwpAlign[];
  borderFills: HwpBorderFill[]; // 1-based(인덱스 0 은 placeholder)
}

function readWStr(dv: DataView, off: number): string {
  const len = dv.getUint16(off, true);
  let s = "";
  for (let i = 0; i < len; i++) s += String.fromCharCode(dv.getUint16(off + 2 + i * 2, true));
  return s;
}

function hex2(n: number): string {
  return n.toString(16).padStart(2, "0");
}

/** COLORREF(0x00BBGGRR) 바이트 → #rrggbb. */
function colorAt(d: Uint8Array, off: number): string {
  return `#${hex2(d[off] ?? 0)}${hex2(d[off + 1] ?? 0)}${hex2(d[off + 2] ?? 0)}`;
}
function borderAt(d: Uint8Array, off: number): HwpBorder {
  const type = d[off] ?? 0; // 0 = NONE
  return { width: type === 0 ? 0 : 1, color: colorAt(d, off + 2) };
}
/** BORDER_FILL payload(근사 파싱) → 테두리 4변 + 배경. */
function parseBorderFill(d: Uint8Array): HwpBorderFill {
  // 0:property(2) | 2:left,8:right,14:top,20:bottom (각 type1+width1+color4) | 32:fillType(4) | 36:faceColor(4)
  const left = borderAt(d, 2);
  const right = borderAt(d, 8);
  const top = borderAt(d, 14);
  const bottom = borderAt(d, 20);
  let bg: string | undefined;
  if (d.length >= 40) {
    const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
    const fillType = dv.getUint32(32, true);
    if (fillType & 0x01) bg = colorAt(d, 36); // 단색 채우기 faceColor
  }
  return { left, right, top, bottom, bg };
}

export function parseHwpStyles(docInfo: Uint8Array): HwpStyles {
  const faces: string[] = [];
  const charShapes: HwpCharShape[] = [];
  const paraShapes: HwpAlign[] = [];
  const borderFills: HwpBorderFill[] = [];

  for (const r of parseRecords(docInfo)) {
    const d = r.data;
    const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
    if (r.tag === HWPTAG_BORDER_FILL) {
      borderFills.push(parseBorderFill(d));
    } else if (r.tag === HWPTAG_FACE_NAME) {
      // 0: property(UINT8), 1: UINT16 len + WCHAR name
      faces.push(d.length > 3 ? readWStr(dv, 1) : "");
    } else if (r.tag === HWPTAG_CHAR_SHAPE && d.length >= 54) {
      const prop = dv.getUint32(46, true);
      const r8 = d[52]!,
        g8 = d[53]!,
        b8 = d[54]!;
      const black = r8 === 0 && g8 === 0 && b8 === 0;
      charShapes.push({
        sizePt: Math.round((dv.getInt32(42, true) / 100) * 10) / 10,
        color: black ? undefined : `#${hex2(r8)}${hex2(g8)}${hex2(b8)}`,
        italic: !!(prop & 0x01),
        bold: !!(prop & 0x02),
        underline: !!((prop >> 2) & 0x03),
        strike: !!((prop >> 18) & 0x07),
        faceId: dv.getUint16(2, true), // 한글 face (index 1)
      });
    } else if (r.tag === HWPTAG_PARA_SHAPE && d.length >= 4) {
      const align = (dv.getUint32(0, true) >> 2) & 0x07;
      paraShapes.push(align === 1 ? "left" : align === 2 ? "right" : align === 3 ? "center" : "justify");
    }
  }
  return { faces, charShapes, paraShapes, borderFills };
}

/** PARA_CHAR_SHAPE payload → [{pos, shapeId}] (위치별 글자모양 변경점). */
export function parseCharShapeRuns(data: Uint8Array): { pos: number; shapeId: number }[] {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const out: { pos: number; shapeId: number }[] = [];
  for (let i = 0; i + 8 <= data.length; i += 8) {
    out.push({ pos: dv.getUint32(i, true), shapeId: dv.getUint32(i + 4, true) });
  }
  return out;
}
