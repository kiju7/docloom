/**
 * xl/styles.xml + xl/theme/theme1.xml → 셀 스타일 index 별 CSS.
 *
 * 셀의 s="N" → cellXfs[N] → fontId/fillId 로 글자색·굵게·기울임·셀 배경·정렬을 얻는다.
 * 색은 rgb(ARGB)·theme(테마+tint)·indexed(레거시 팔레트) 세 방식을 해석한다.
 */
import { parseXml, childrenOf, findChild, findChildren, attrOf, type XmlNode } from "../core/xml.js";

export interface XlsxStyles {
  /** xf index → 인라인 CSS 선언("color:#..;font-weight:bold;background-color:#.."). */
  css: string[];
}

const EMPTY: XlsxStyles = { css: [] };

export function parseXlsxStyles(stylesXml: string | undefined, themeXml: string | undefined): XlsxStyles {
  if (!stylesXml) return EMPTY;
  const tree = parseXml(stylesXml);
  const root = tree.find((n) => Object.keys(n)[0] === "styleSheet");
  if (!root) return EMPTY;
  const top = childrenOf(root);
  const theme = parseThemePalette(themeXml);

  const fonts = childElems(top, "fonts", "font").map((f) => readFont(childrenOf(f), theme));
  const fills = childElems(top, "fills", "fill").map((f) => readFill(childrenOf(f), theme));
  const borders = childElems(top, "borders", "border").map((b) => readBorder(childrenOf(b), theme));

  const xfs = childElems(top, "cellXfs", "xf").map((xf) => {
    const fontId = Number(attrOf(xf, "fontId") ?? "0");
    const fillId = Number(attrOf(xf, "fillId") ?? "0");
    const borderId = Number(attrOf(xf, "borderId") ?? "0");
    const applyFont = attrOf(xf, "applyFont") !== "0";
    const applyFill = attrOf(xf, "applyFill") !== "0";
    const applyBorder = attrOf(xf, "applyBorder") !== "0";
    const alignNode = findChild(childrenOf(xf), "alignment");
    const align = attrOf(alignNode ?? {}, "horizontal");
    const valign = attrOf(alignNode ?? {}, "vertical");

    const decls: string[] = [];
    const font = fonts[fontId];
    if (font && applyFont) {
      if (font.color) decls.push(`color:${font.color}`);
      if (font.bold) decls.push("font-weight:bold");
      if (font.italic) decls.push("font-style:italic");
      if (font.underline) decls.push("text-decoration:underline");
      if (font.sizePt) decls.push(`font-size:${font.sizePt}pt`);
      // 인라인 style 속성 안이므로 작은따옴표(큰따옴표 쓰면 style 속성이 조기 종료돼 뒤 선언이 다 무시됨)
      if (font.name) decls.push(`font-family:'${font.name}',sans-serif`);
    }
    const fill = fills[fillId];
    if (fill?.color && applyFill) decls.push(`background-color:${fill.color}`);
    const border = borders[borderId];
    if (border && applyBorder) {
      if (border.top) decls.push(`border-top:${border.top}`);
      if (border.right) decls.push(`border-right:${border.right}`);
      if (border.bottom) decls.push(`border-bottom:${border.bottom}`);
      if (border.left) decls.push(`border-left:${border.left}`);
    }
    if (align === "center" || align === "right" || align === "left") decls.push(`text-align:${align}`);
    const va = valign === "center" ? "middle" : valign === "top" ? "top" : valign === "bottom" ? "bottom" : undefined;
    if (va) decls.push(`vertical-align:${va}`);
    return decls.join(";");
  });

  return { css: xfs };
}

/** 컨테이너(<fonts> 등)에서 지정 태그(<font> 등) 요소만 순서대로 — 공백 텍스트 노드 제외. */
function childElems(top: XmlNode[], container: string, childTag: string): XmlNode[] {
  const node = findChild(top, container);
  return node ? findChildren(childrenOf(node), childTag) : [];
}

interface Font { color?: string; bold?: boolean; italic?: boolean; underline?: boolean; sizePt?: number; name?: string; }
function readFont(kids: XmlNode[], theme: Record<string, string>): Font {
  const f: Font = {};
  if (findChild(kids, "b")) f.bold = true;
  if (findChild(kids, "i")) f.italic = true;
  if (findChild(kids, "u")) f.underline = true;
  const color = findChild(kids, "color");
  if (color) f.color = resolveColor(color, theme);
  const sz = findChild(kids, "sz");
  if (sz) {
    const n = Number(attrOf(sz, "val"));
    if (Number.isFinite(n)) f.sizePt = n;
  }
  const name = findChild(kids, "name") ?? findChild(kids, "rFont");
  if (name) {
    const v = attrOf(name, "val");
    if (v) f.name = v;
  }
  return f;
}

interface Border { top?: string; right?: string; bottom?: string; left?: string; }
function readBorder(kids: XmlNode[], theme: Record<string, string>): Border {
  const b: Border = {};
  for (const side of ["top", "right", "bottom", "left"] as const) {
    const node = findChild(kids, side);
    if (!node) continue;
    const style = attrOf(node, "style");
    if (!style || style === "none") continue;
    const colorNode = findChild(childrenOf(node), "color");
    const color = (colorNode && resolveColor(colorNode, theme)) || "#9aa0a6";
    b[side] = `${borderCss(style)} ${color}`;
  }
  return b;
}

/** OOXML 테두리 스타일 → CSS "width style". */
function borderCss(style: string): string {
  switch (style) {
    case "thick": return "3px solid";
    case "medium": case "mediumDashed": case "mediumDashDot": return "2px solid";
    case "double": return "3px double";
    case "dashed": case "dashDot": case "dashDotDot": return "1px dashed";
    case "dotted": return "1px dotted";
    case "hair": case "thin": default: return "1px solid";
  }
}

interface Fill { color?: string; }
function readFill(kids: XmlNode[], theme: Record<string, string>): Fill {
  const pattern = findChild(kids, "patternFill");
  if (!pattern) return {};
  const type = attrOf(pattern, "patternType");
  if (!type || type === "none") return {};
  const pk = childrenOf(pattern);
  const fg = findChild(pk, "fgColor");
  if (fg) {
    const c = resolveColor(fg, theme);
    if (c) return { color: c };
  }
  return {};
}

/** <color rgb|theme|indexed|auto + tint> → "#RRGGBB" (없으면 undefined). */
function resolveColor(node: XmlNode, theme: Record<string, string>): string | undefined {
  if (attrOf(node, "auto") === "1") return undefined;
  const rgb = attrOf(node, "rgb");
  if (rgb) return "#" + (rgb.length === 8 ? rgb.slice(2) : rgb);
  const themeIdx = attrOf(node, "theme");
  if (themeIdx !== undefined) {
    const base = theme[THEME_ORDER[Number(themeIdx)] ?? ""];
    if (base) return "#" + applyTint(base, Number(attrOf(node, "tint") ?? "0"));
  }
  const indexed = attrOf(node, "indexed");
  if (indexed !== undefined) {
    const c = INDEXED[Number(indexed)];
    if (c) return "#" + c;
  }
  return undefined;
}

/** SpreadsheetML 의 color@theme 인덱스 → 테마 색 이름. */
const THEME_ORDER = ["lt1", "dk1", "lt2", "dk2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6", "hlink", "folHlink"];

/** theme1.xml 의 a:clrScheme → 이름→hex(6자리). 가벼운 정규식 추출. */
function parseThemePalette(themeXml: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!themeXml) return out;
  const m = themeXml.match(/<a:clrScheme[\s\S]*?<\/a:clrScheme>/);
  if (!m) return out;
  const block = m[0];
  // clrScheme 자식 순서: dk1,lt1,dk2,lt2,accent1..6,hlink,folHlink
  const names = ["dk1", "lt1", "dk2", "lt2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6", "hlink", "folHlink"];
  const re = /<a:(\w+)>\s*<a:(srgbClr|sysClr)[^>]*?(?:val|lastClr)="([0-9A-Fa-f]{6})"/g;
  let mm: RegExpExecArray | null;
  while ((mm = re.exec(block))) {
    if (names.includes(mm[1]!)) out[mm[1]!] = mm[3]!.toUpperCase();
  }
  return out;
}

/** 테마 색 tint 적용(근사): tint<0 어둡게, >0 밝게. */
function applyTint(hex: string, tint: number): string {
  if (!tint) return hex;
  const ch = (i: number) => parseInt(hex.substr(i, 2), 16);
  const adj = (v: number) => {
    const x = tint < 0 ? v * (1 + tint) : v * (1 - tint) + 255 * tint;
    return Math.max(0, Math.min(255, Math.round(x)));
  };
  const to2 = (v: number) => v.toString(16).padStart(2, "0");
  return (to2(adj(ch(0))) + to2(adj(ch(2))) + to2(adj(ch(4)))).toUpperCase();
}

/** 레거시 indexed 팔레트(표준 BIFF8 일부 — 자주 쓰는 것 위주). */
const INDEXED: Record<number, string> = {
  0: "000000", 1: "FFFFFF", 2: "FF0000", 3: "00FF00", 4: "0000FF", 5: "FFFF00",
  6: "FF00FF", 7: "00FFFF", 8: "000000", 9: "FFFFFF", 10: "FF0000", 11: "00FF00",
  12: "0000FF", 13: "FFFF00", 14: "FF00FF", 15: "00FFFF", 16: "800000", 17: "008000",
  18: "000080", 19: "808000", 20: "800080", 21: "008080", 22: "C0C0C0", 23: "808080",
  40: "00CCFF", 41: "CCFFFF", 42: "CCFFCC", 43: "FFFF99", 44: "99CCFF", 45: "FF99CC",
  46: "CC99FF", 47: "FFCC99", 48: "3366FF", 49: "33CCCC", 50: "99CC00", 51: "FFCC00",
  52: "FF9900", 53: "FF6600", 54: "666699", 55: "969696", 56: "003366", 57: "339966",
  58: "003300", 59: "333300", 60: "993300", 61: "993366", 62: "333399", 63: "333333",
  64: "000000", 65: "FFFFFF",
};
