/**
 * styles.xml → 동적 팔레트 생성.
 *
 * 실제 docx 의 styleId 는 "Heading1" 같은 영어 이름이 아니라 "1", "a8", "1-10"
 * 처럼 워드/한글이 자동 생성한 토큰인 경우가 대부분이다. 고정 팔레트로는 매칭이
 * 안 되므로, 문서 자신의 styles.xml 을 스캔해 styleId 별 팔레트 엔트리를 만든다.
 *
 *   - 문단 스타일(w:type="paragraph")만 대상
 *   - w:pPr/w:outlineLvl 이 있으면 제목 → h{lvl+1}, 없으면 p
 *   - w:default="1" 스타일을 fallback 으로 (없으면 name="Normal" 또는 첫 엔트리)
 *   - styleKey 는 CSS class 안전 토큰으로 정규화(중복 시 접미사)
 */
import { parseXml, tagOf, childrenOf, attrOf, findChild } from "../docx/ooxml.js";
import type { Palette, PaletteEntry } from "./palette.js";

export function buildPaletteFromStyles(stylesXml: string, id = "doc"): Palette {
  const tree = parseXml(stylesXml);
  const stylesNode = tree.find((n) => tagOf(n) === "w:styles");
  const entries: PaletteEntry[] = [];
  const usedKeys = new Set<string>();
  let fallback: string | undefined;

  if (stylesNode) {
    for (const s of childrenOf(stylesNode)) {
      if (tagOf(s) !== "w:style") continue;
      const type = attrOf(s, "w:type");
      if (type && type !== "paragraph") continue;
      const styleId = attrOf(s, "w:styleId");
      if (!styleId) continue;

      const kids = childrenOf(s);
      const pPr = findChild(kids, "w:pPr");
      const outline = pPr ? findChild(childrenOf(pPr), "w:outlineLvl") : undefined;
      const lvl = outline ? Number(attrOf(outline, "w:val")) : NaN;

      let htmlTag: PaletteEntry["htmlTag"] = "p";
      if (Number.isFinite(lvl)) {
        const h = Math.min(6, Math.max(1, lvl + 1));
        htmlTag = `h${h}` as PaletteEntry["htmlTag"];
      }

      const styleKey = sanitizeKey(styleId, usedKeys);
      entries.push({ styleKey, docxStyleId: styleId, htmlTag });

      if (attrOf(s, "w:default") === "1") fallback = styleKey;
    }
  }

  if (!fallback) {
    const normal = entries.find((e) => e.docxStyleId.toLowerCase() === "normal");
    fallback = normal?.styleKey ?? entries[0]?.styleKey;
  }
  if (!fallback) {
    entries.push({ styleKey: "body", docxStyleId: "Normal", htmlTag: "p" });
    fallback = "body";
  }

  return { id, entries, fallbackStyleKey: fallback };
}

/** styleId → CSS class 안전 토큰. 허용: [A-Za-z0-9_-]. 중복은 접미사로 회피. */
function sanitizeKey(styleId: string, used: Set<string>): string {
  let base = styleId.replace(/[^A-Za-z0-9_-]/g, "_");
  if (base === "") base = "s";
  let out = base;
  let i = 1;
  while (used.has(out)) out = `${base}_${i++}`;
  used.add(out);
  return out;
}
