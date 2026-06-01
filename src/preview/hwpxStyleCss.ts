/**
 * HWPX header.xml → 미리보기 CSS 추출기 (docx 의 styleCss.ts 대응).
 *
 * 원본 문서의 문단 스타일(글자 크기·색·굵게·정렬)을 팔레트 class(.s-<styleKey>) CSS 로
 * 변환한다. HWPX 는 스타일이 charPr/paraPr 를 id 참조하므로 두 단계로 따라간다:
 *   hh:style(@charPrIDRef,@paraPrIDRef) → hh:charPr / hh:paraPr 정의
 *
 * HWPX 단위 메모
 *   charPr@height  1/100 pt   → pt = height / 100
 *   textColor      #RRGGBB
 *   align@horizontal LEFT|CENTER|RIGHT|JUSTIFY|DISTRIBUTE
 */
import { parseXml, tagOf, childrenOf, attrOf, type XmlNode } from "../core/xml.js";
import type { Palette } from "../palette/palette.js";

function localName(node: XmlNode): string {
  const t = tagOf(node);
  const i = t.indexOf(":");
  return i >= 0 ? t.slice(i + 1) : t;
}
function collectByLocal(nodes: XmlNode[], local: string, out: XmlNode[] = []): XmlNode[] {
  for (const n of nodes) {
    if (localName(n) === local) out.push(n);
    collectByLocal(childrenOf(n), local, out);
  }
  return out;
}
function findChildLocal(node: XmlNode, local: string): XmlNode | undefined {
  return childrenOf(node).find((c) => localName(c) === local);
}

interface CharProps {
  sizePt?: number;
  color?: string;
  bold?: boolean;
  italic?: boolean;
}

/** header.xml + 팔레트 → 스타일별 미리보기 CSS. 추출 불가면 빈 문자열. */
export function extractHwpxStyleCss(headerXml: string | undefined, palette: Palette): string {
  if (!headerXml) return "";
  const tree = parseXml(headerXml);

  const charById = new Map<string, CharProps>();
  for (const cp of collectByLocal(tree, "charPr")) {
    const id = attrOf(cp, "id");
    if (id === undefined) continue;
    const h = Number(attrOf(cp, "height"));
    const color = attrOf(cp, "textColor");
    charById.set(id, {
      sizePt: Number.isFinite(h) ? h / 100 : undefined,
      color: color && /^#?[0-9a-fA-F]{6}$/.test(color) ? (color.startsWith("#") ? color : `#${color}`) : undefined,
      bold: !!findChildLocal(cp, "bold"),
      italic: !!findChildLocal(cp, "italic"),
    });
  }

  const alignById = new Map<string, string>();
  for (const pp of collectByLocal(tree, "paraPr")) {
    const id = attrOf(pp, "id");
    if (id === undefined) continue;
    const align = findChildLocal(pp, "align");
    const h = align ? attrOf(align, "horizontal") : undefined;
    if (h) alignById.set(id, mapAlign(h));
  }

  const styleRefs = new Map<string, { charRef?: string; paraRef?: string }>();
  for (const st of collectByLocal(tree, "style")) {
    const id = attrOf(st, "id");
    if (id === undefined) continue;
    styleRefs.set(id, { charRef: attrOf(st, "charPrIDRef"), paraRef: attrOf(st, "paraPrIDRef") });
  }

  const rules: string[] = [];
  for (const entry of palette.entries) {
    const refs = styleRefs.get(entry.docxStyleId);
    if (!refs) continue;
    const cp = refs.charRef !== undefined ? charById.get(refs.charRef) : undefined;
    const align = refs.paraRef !== undefined ? alignById.get(refs.paraRef) : undefined;
    const decls: string[] = [];
    if (cp?.sizePt) decls.push(`font-size:${round(cp.sizePt)}pt`);
    if (cp?.bold) decls.push("font-weight:700");
    if (cp?.italic) decls.push("font-style:italic");
    if (cp?.color) decls.push(`color:${cp.color}`);
    if (align) decls.push(`text-align:${align}`);
    if (decls.length) rules.push(`.docloom-doc .s-${entry.styleKey} { ${decls.join("; ")}; }`);
  }
  return rules.join("\n");
}

function mapAlign(h: string): string {
  switch (h.toUpperCase()) {
    case "CENTER":
      return "center";
    case "RIGHT":
      return "right";
    case "JUSTIFY":
    case "DISTRIBUTE":
      return "justify";
    default:
      return "left";
  }
}
function round(n: number): number {
  return Math.round(n * 10) / 10;
}
