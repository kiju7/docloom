/**
 * HWPX header.xml 서식 테이블 파서 (미리보기 충실도용).
 *
 * 미리보기에서 글자색·크기·정렬·표 테두리/배경을 원본처럼 보이려면 header.xml 의 서식
 * 정의를 ID 별로 읽어야 한다(본문은 charPrIDRef/paraPrIDRef/borderFillIDRef 로 참조).
 *   hh:charPr      → 크기(height/100 pt)·색(textColor)·굵게/기울임/밑줄/취소선·글꼴ref
 *   hh:paraPr      → 정렬(hp:align@horizontal)
 *   hh:borderFill  → 4변 테두리(type/width/color) + 배경(fillBrush faceColor)
 *   hh:fontface    → 글꼴 이름
 */
import { parseXml, tagOf, childrenOf, attrOf, type XmlNode } from "../core/xml.js";

export interface CharPr {
  sizePt?: number;
  color?: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  font?: string;
  super?: boolean; // 위첨자(<hh:supscript/>) — rhwp 가 노출 안 함
  sub?: boolean;   // 아래첨자(<hh:subscript/>)
}
export interface Border {
  width: number; // px (0 = 없음)
  color: string;
}
export interface BorderFill {
  left: Border;
  right: Border;
  top: Border;
  bottom: Border;
  bg?: string; // 단색 배경색 (#rrggbb) — winBrush faceColor
  /** CSS background 값(단색 또는 그라데이션). rhwp 가 그라데이션을 흰색으로 떨구는 것을 raw 로 보강할 때 쓴다. */
  bgCss?: string;
}
export interface HwpxStyles {
  charPr: Map<string, CharPr>;
  align: Map<string, string>; // paraPr id → text-align
  borderFill: Map<string, BorderFill>;
}

function local(node: XmlNode): string {
  const t = tagOf(node);
  const i = t.indexOf(":");
  return i >= 0 ? t.slice(i + 1) : t;
}
function collect(nodes: XmlNode[], name: string, out: XmlNode[] = []): XmlNode[] {
  for (const n of nodes) {
    if (local(n) === name) out.push(n);
    collect(childrenOf(n), name, out);
  }
  return out;
}
function childLocal(node: XmlNode, name: string): XmlNode | undefined {
  return childrenOf(node).find((c) => local(c) === name);
}
function color(v: string | undefined): string | undefined {
  if (!v || v.toUpperCase() === "NONE") return undefined;
  return /^#?[0-9a-fA-F]{6}$/.test(v) ? (v.startsWith("#") ? v : `#${v}`) : undefined;
}
/** "0.4 mm" → px. (1mm ≈ 3.78px) */
function widthPx(v: string | undefined): number {
  if (!v) return 0;
  const m = v.match(/([\d.]+)\s*mm/);
  if (m) return Math.max(1, Math.round(Number(m[1]) * 3.7795));
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? 1 : 0;
}
function border(node: XmlNode | undefined): Border {
  if (!node) return { width: 0, color: "#000000" };
  const type = (attrOf(node, "type") ?? "NONE").toUpperCase();
  return { width: type === "NONE" ? 0 : widthPx(attrOf(node, "width")), color: color(attrOf(node, "color")) ?? "#000000" };
}

export function parseHwpxStyles(headerXml: string | undefined): HwpxStyles {
  const charPr = new Map<string, CharPr>();
  const align = new Map<string, string>();
  const borderFill = new Map<string, BorderFill>();
  if (!headerXml) return { charPr, align, borderFill };
  const tree = parseXml(headerXml);

  for (const cp of collect(tree, "charPr")) {
    const id = attrOf(cp, "id");
    if (id === undefined) continue;
    const h = Number(attrOf(cp, "height"));
    const underline = childLocal(cp, "underline");
    const strikeout = childLocal(cp, "strikeout");
    const fontRef = childLocal(cp, "fontRef");
    charPr.set(id, {
      sizePt: Number.isFinite(h) ? Math.round((h / 100) * 10) / 10 : undefined,
      color: color(attrOf(cp, "textColor")),
      bold: !!childLocal(cp, "bold"),
      italic: !!childLocal(cp, "italic"),
      underline: !!underline && (attrOf(underline, "type") ?? "BOTTOM").toUpperCase() !== "NONE",
      strike: !!strikeout && (attrOf(strikeout, "shape") ?? "SOLID").toUpperCase() !== "NONE",
      font: fontRef ? attrOf(fontRef, "hangul") : undefined,
      super: !!childLocal(cp, "supscript"),
      sub: !!childLocal(cp, "subscript"),
    });
  }

  for (const pp of collect(tree, "paraPr")) {
    const id = attrOf(pp, "id");
    if (id === undefined) continue;
    const a = childLocal(pp, "align");
    const h = (a ? attrOf(a, "horizontal") : undefined)?.toUpperCase();
    align.set(id, h === "LEFT" ? "left" : h === "RIGHT" ? "right" : h === "CENTER" ? "center" : "justify");
  }

  for (const bf of collect(tree, "borderFill")) {
    const id = attrOf(bf, "id");
    if (id === undefined) continue;
    const brush = childLocal(bf, "fillBrush");
    const win = brush ? childLocal(brush, "winBrush") : undefined;
    const bg = win ? color(attrOf(win, "faceColor")) : undefined;
    // 그라데이션 채움 → CSS gradient (rhwp 는 그라데이션을 해석 못 해 흰색으로 떨군다).
    let bgCss = bg;
    const grad = brush ? childLocal(brush, "gradation") : undefined;
    if (!bgCss && grad) {
      const colors = childrenOf(grad).filter((c) => local(c) === "color")
        .map((c) => color(attrOf(c, "value"))).filter((c): c is string => !!c);
      if (colors.length >= 2) {
        const type = (attrOf(grad, "type") ?? "LINEAR").toUpperCase();
        const angle = Number(attrOf(grad, "angle")) || 0;
        bgCss = type === "RADIAL"
          ? `radial-gradient(circle, ${colors.join(", ")})`
          : `linear-gradient(${angle + 90}deg, ${colors.join(", ")})`;
      } else if (colors.length === 1) bgCss = colors[0];
    }
    borderFill.set(id, {
      left: border(childLocal(bf, "leftBorder")),
      right: border(childLocal(bf, "rightBorder")),
      top: border(childLocal(bf, "topBorder")),
      bottom: border(childLocal(bf, "bottomBorder")),
      bg, bgCss,
    });
  }

  return { charPr, align, borderFill };
}

/**
 * 글꼴 id → 이름 맵. fontface 는 언어별(HANGUL/LATIN/…)로 같은 id 공간을 쓰므로,
 * 한글 텍스트 기준으로 **HANGUL fontface** 를 우선 사용한다(없으면 첫 언어). charPr.fontRef
 * 의 hangul id 가 이 맵을 가리킨다.
 */
export function parseFontMap(headerXml: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!headerXml) return map;
  const faces = collect(parseXml(headerXml), "fontface");
  const hangul = faces.find((f) => (attrOf(f, "lang") ?? "").toUpperCase() === "HANGUL");
  const target = hangul ?? faces[0];
  if (!target) return map;
  for (const f of childrenOf(target)) {
    if (local(f) !== "font") continue;
    const id = attrOf(f, "id");
    const face = attrOf(f, "face");
    if (id !== undefined && face) map.set(id, face);
  }
  return map;
}
