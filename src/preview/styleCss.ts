/**
 * styles.xml → 미리보기 CSS 추출기.
 *
 * 원본 docx 의 실제 스타일 정의(글꼴·크기·굵기·정렬·색·여백·들여쓰기)를 읽어
 * 팔레트 class(.s-<styleKey>) 에 대응하는 CSS 로 변환한다. → "원본 양식 그대로" 미리보기.
 *
 * OOXML 단위 메모
 *   w:sz       반(half) 포인트   → pt = val / 2
 *   w:spacing  twips(1/20 pt)    → pt = val / 20
 *   w:ind      twips(1/20 pt)    → pt = val / 20
 *   w:color    16진수("FF0000")  → #FF0000  ("auto" 는 무시)
 *   w:jc       both→justify, center, right/end→right, left/start→left
 *
 * 상속 처리: docDefaults(문서 기본) → w:basedOn 체인 → 스타일 자신 순으로 병합.
 */
import type { Palette } from "../palette/palette.js";
import { parseXml, tagOf, childrenOf, attrOf, findChild, type XmlNode } from "../docx/ooxml.js";

/** auto 줄간격(line/240)을 CSS line-height 배수로 환산할 때 곱하는 폰트 메트릭 보정.
 *  본문 한글 폰트(맑은 고딕 등) 자연 줄높이/em ≈ 1.7. truth PDF 의 줄간격과 맞춘 값. */
const LINE_AUTO_FACTOR = 1.7;

interface TextProps {
  fontSizePt?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  color?: string;
  fontFamily?: string;
  align?: string;
  lineHeight?: string; // CSS line-height 값(배수 또는 pt)
  marginTopPt?: number;
  marginBottomPt?: number;
  indentLeftPt?: number;
  firstLineIndentPt?: number;
  /** 문단 테두리(w:pBdr) — 예: 제목 스타일의 밑줄. CSS border 값. */
  borderTop?: string;
  borderBottom?: string;
  borderLeft?: string;
  borderRight?: string;
  /** 문단 음영(w:shd fill). */
  background?: string;
}

export interface ExtractOptions {
  /** theme1.xml 내용. asciiTheme/eastAsiaTheme 폰트 참조를 실제 폰트명으로 해석. */
  themeXml?: string;
}

interface ThemeFonts {
  major: { latin?: string; ea?: string };
  minor: { latin?: string; ea?: string };
}

/** styles.xml 문자열(없으면 undefined) → 팔레트 class 별 CSS 규칙 문자열. */
export function extractStyleCss(
  stylesXml: string | undefined,
  palette: Palette,
  opts: ExtractOptions = {},
): string {
  if (!stylesXml) return "";
  const tree = parseXml(stylesXml);
  const stylesNode = tree.find((n) => tagOf(n) === "w:styles");
  if (!stylesNode) return "";
  const top = childrenOf(stylesNode);

  const theme = opts.themeXml ? parseThemeFonts(opts.themeXml) : undefined;
  const docDefaults = readDocDefaults(top, theme);
  const styleDefs = readStyleDefs(top, theme);

  const rules: string[] = [];

  // 문서 기본(본문 컨테이너) — 크기 미지정 스타일은 이걸 상속한다.
  const baseDecl = propsToCss({
    fontSizePt: docDefaults.fontSizePt ?? 11,
    fontFamily: docDefaults.fontFamily,
  });
  if (baseDecl) rules.push(`.docloom-doc { ${baseDecl}; }`);

  for (const entry of palette.entries) {
    const eff = resolveStyle(entry.docxStyleId, styleDefs, docDefaults, new Set());
    const decl = propsToCss(eff);
    if (decl) rules.push(`.docloom-doc .s-${entry.styleKey} { ${decl}; }`);
  }
  return rules.join("\n");
}

function readDocDefaults(top: XmlNode[], theme: ThemeFonts | undefined): TextProps {
  const dd = findChild(top, "w:docDefaults");
  if (!dd) return {};
  const ddKids = childrenOf(dd);
  const rPrDef = findChild(ddKids, "w:rPrDefault");
  const pPrDef = findChild(ddKids, "w:pPrDefault");
  const rPr = rPrDef ? findChild(childrenOf(rPrDef), "w:rPr") : undefined;
  const pPr = pPrDef ? findChild(childrenOf(pPrDef), "w:pPr") : undefined;
  return merge(readPPr(pPr), readRPr(rPr, theme));
}

interface StyleDef {
  basedOn?: string;
  props: TextProps;
}

function readStyleDefs(top: XmlNode[], theme: ThemeFonts | undefined): Map<string, StyleDef> {
  const map = new Map<string, StyleDef>();
  for (const s of top.filter((n) => tagOf(n) === "w:style")) {
    const id = attrOf(s, "w:styleId");
    if (!id) continue;
    const kids = childrenOf(s);
    const basedOnNode = findChild(kids, "w:basedOn");
    const basedOn = basedOnNode ? attrOf(basedOnNode, "w:val") : undefined;
    const props = merge(readPPr(findChild(kids, "w:pPr")), readRPr(findChild(kids, "w:rPr"), theme));
    map.set(id, { basedOn, props });
  }
  return map;
}

function resolveStyle(
  styleId: string,
  defs: Map<string, StyleDef>,
  docDefaults: TextProps,
  seen: Set<string>,
): TextProps {
  const def = defs.get(styleId);
  if (!def || seen.has(styleId)) return { ...docDefaults };
  seen.add(styleId);
  const base = def.basedOn
    ? resolveStyle(def.basedOn, defs, docDefaults, seen)
    : { ...docDefaults };
  return merge(base, def.props);
}

// ── 속성 읽기 ────────────────────────────────────────────────────────────

function readRPr(rPr: XmlNode | undefined, theme: ThemeFonts | undefined): TextProps {
  const p: TextProps = {};
  if (!rPr) return p;
  const kids = childrenOf(rPr);

  const sz = findChild(kids, "w:sz");
  if (sz) {
    const n = Number(attrOf(sz, "w:val"));
    if (Number.isFinite(n)) p.fontSizePt = n / 2;
  }
  const b = readToggle(findChild(kids, "w:b"));
  if (b !== undefined) p.bold = b;
  const i = readToggle(findChild(kids, "w:i"));
  if (i !== undefined) p.italic = i;

  const u = findChild(kids, "w:u");
  if (u) {
    const v = attrOf(u, "w:val");
    p.underline = v ? v.toLowerCase() !== "none" : true;
  }
  const color = findChild(kids, "w:color");
  if (color) {
    const v = attrOf(color, "w:val");
    if (v && v.toLowerCase() !== "auto") p.color = `#${v}`;
  }
  const rFonts = findChild(kids, "w:rFonts");
  if (rFonts) {
    const latin = attrOf(rFonts, "w:ascii") ?? themeFont(theme, attrOf(rFonts, "w:asciiTheme") ?? attrOf(rFonts, "w:hAnsiTheme"));
    const east = attrOf(rFonts, "w:eastAsia") ?? themeFont(theme, attrOf(rFonts, "w:eastAsiaTheme"));
    const fonts = [latin, east].filter((x): x is string => !!x);
    if (fonts.length) p.fontFamily = [...new Set(fonts)].map((f) => `"${f}"`).join(", ");
  }
  return p;
}

/** theme 폰트 참조("majorHAnsi" 등) → 실제 폰트명. */
function themeFont(theme: ThemeFonts | undefined, ref: string | undefined): string | undefined {
  if (!theme || !ref) return undefined;
  const ea = ref.toLowerCase().includes("eastasia");
  if (ref.startsWith("major")) return ea ? theme.major.ea : theme.major.latin;
  if (ref.startsWith("minor")) return ea ? theme.minor.ea : theme.minor.latin;
  return undefined;
}

/** theme1.xml → major/minor 폰트(latin/ea). 가벼운 정규식 추출. */
function parseThemeFonts(themeXml: string): ThemeFonts {
  const grab = (block: string): { latin?: string; ea?: string } => {
    const m = themeXml.match(new RegExp(`<a:${block}>([\\s\\S]*?)</a:${block}>`));
    if (!m) return {};
    const latin = m[1]!.match(/<a:latin[^>]*typeface="([^"]*)"/);
    const ea = m[1]!.match(/<a:ea[^>]*typeface="([^"]*)"/);
    return { latin: latin?.[1] || undefined, ea: ea?.[1] || undefined };
  };
  return { major: grab("majorFont"), minor: grab("minorFont") };
}

function readPPr(pPr: XmlNode | undefined): TextProps {
  const p: TextProps = {};
  if (!pPr) return p;
  const kids = childrenOf(pPr);

  const jc = findChild(kids, "w:jc");
  if (jc) {
    const a = mapAlign(attrOf(jc, "w:val"));
    if (a) p.align = a;
  }
  const spacing = findChild(kids, "w:spacing");
  if (spacing) {
    const after = Number(attrOf(spacing, "w:after"));
    if (Number.isFinite(after)) p.marginBottomPt = after / 20;
    const before = Number(attrOf(spacing, "w:before"));
    if (Number.isFinite(before)) p.marginTopPt = before / 20;
    // 줄간격: exact/atLeast → 절대 pt. auto → (line/240) × 폰트메트릭 보정.
    // Word 의 auto 한 줄(=240)은 폰트의 ascent+descent+linegap 높이라, CSS line-height
    // 의 "글자크기 배수"로 환산하려면 폰트 자연 줄높이 비율을 곱해야 한다. 본문 한글
    // 폰트(맑은 고딕 등)의 그 비율이 ~1.7 이라, 그대로면(=line/240) 너무 빽빽해진다.
    const line = Number(attrOf(spacing, "w:line"));
    const lineRule = attrOf(spacing, "w:lineRule");
    if (Number.isFinite(line) && line > 0) {
      p.lineHeight =
        lineRule === "exact" || lineRule === "atLeast"
          ? `${round(line / 20)}pt`
          : `${round((line / 240) * LINE_AUTO_FACTOR)}`;
    }
  }
  const ind = findChild(kids, "w:ind");
  if (ind) {
    const left = Number(attrOf(ind, "w:left") ?? attrOf(ind, "w:start"));
    if (Number.isFinite(left)) p.indentLeftPt = left / 20;
    const first = Number(attrOf(ind, "w:firstLine"));
    if (Number.isFinite(first)) p.firstLineIndentPt = first / 20;
  }

  // 문단 테두리(w:pBdr) — 제목 스타일의 아래 밑줄 등. 스타일 정의에서 가져온다.
  const pBdr = findChild(kids, "w:pBdr");
  if (pBdr) {
    const bk = childrenOf(pBdr);
    const top = pBorderToCss(findChild(bk, "w:top"));
    const bottom = pBorderToCss(findChild(bk, "w:bottom"));
    const left = pBorderToCss(findChild(bk, "w:left"));
    const right = pBorderToCss(findChild(bk, "w:right"));
    if (top) p.borderTop = top;
    if (bottom) p.borderBottom = bottom;
    if (left) p.borderLeft = left;
    if (right) p.borderRight = right;
  }
  // 문단 음영(w:shd fill)
  const shd = findChild(kids, "w:shd");
  if (shd) {
    const fill = attrOf(shd, "w:fill");
    if (fill && fill.toLowerCase() !== "auto") p.background = `#${fill}`;
  }
  return p;
}

/** w:pBdr 의 한 변(w:top/bottom/…) → CSS border 값. none/nil 이면 undefined. */
function pBorderToCss(node: XmlNode | undefined): string | undefined {
  if (!node) return undefined;
  const val = attrOf(node, "w:val");
  if (!val || val === "none" || val === "nil") return undefined;
  const sz = Number(attrOf(node, "w:sz")); // 1/8 pt
  const widthPt = Number.isFinite(sz) && sz > 0 ? sz / 8 : 0.5;
  const color = attrOf(node, "w:color");
  const c = color && color.toLowerCase() !== "auto" ? `#${color}` : "#000";
  const style = val === "double" ? "double" : val === "dashed" ? "dashed" : val === "dotted" ? "dotted" : "solid";
  return `${round(widthPt)}pt ${style} ${c}`;
}

/** 토글 속성(w:b 등): 노드 없으면 undefined, w:val 없으면 true, off 계열이면 false. */
function readToggle(n: XmlNode | undefined): boolean | undefined {
  if (!n) return undefined;
  const v = attrOf(n, "w:val");
  if (v === undefined) return true;
  return !["0", "false", "none", "off"].includes(v.toLowerCase());
}

function mapAlign(v: string | undefined): string | undefined {
  switch (v) {
    case "both":
    case "distribute":
      return "justify";
    case "center":
      return "center";
    case "right":
    case "end":
      return "right";
    case "left":
    case "start":
      return "left";
    default:
      return undefined;
  }
}

function merge(base: TextProps, over: TextProps): TextProps {
  return { ...base, ...over };
}

function round(x: number): number {
  return Math.round(x * 100) / 100;
}

function propsToCss(p: TextProps): string {
  const d: string[] = [];
  if (p.fontSizePt !== undefined) d.push(`font-size:${round(p.fontSizePt)}pt`);
  if (p.bold !== undefined) d.push(`font-weight:${p.bold ? 700 : 400}`);
  if (p.italic) d.push(`font-style:italic`);
  if (p.underline) d.push(`text-decoration:underline`);
  if (p.color) d.push(`color:${p.color}`);
  if (p.fontFamily) d.push(`font-family:${p.fontFamily}, "Malgun Gothic", "Apple SD Gothic Neo", sans-serif`);
  if (p.align) d.push(`text-align:${p.align}`);
  if (p.lineHeight) d.push(`line-height:${p.lineHeight}`);
  if (p.marginTopPt !== undefined) d.push(`margin-top:${round(p.marginTopPt)}pt`);
  if (p.marginBottomPt !== undefined) d.push(`margin-bottom:${round(p.marginBottomPt)}pt`);
  if (p.indentLeftPt !== undefined) d.push(`margin-left:${round(p.indentLeftPt)}pt`);
  if (p.firstLineIndentPt !== undefined) d.push(`text-indent:${round(p.firstLineIndentPt)}pt`);
  if (p.borderTop) d.push(`border-top:${p.borderTop}`, `padding-top:4pt`);
  if (p.borderBottom) d.push(`border-bottom:${p.borderBottom}`, `padding-bottom:4pt`);
  if (p.borderLeft) d.push(`border-left:${p.borderLeft}`, `padding-left:6pt`);
  if (p.borderRight) d.push(`border-right:${p.borderRight}`, `padding-right:6pt`);
  if (p.background) d.push(`background-color:${p.background}`);
  return d.join("; ");
}
