/**
 * HWPX header.xml → 동적 팔레트 + 문자서식(charPr) 마크 맵.
 *
 * HWPX 의 스타일/문자속성은 모두 Contents/header.xml 의 refList 에 정의되고, 본문은
 * id 참조(styleIDRef/charPrIDRef)로 그것을 가리킨다. 여기서 header 를 스캔해:
 *   - 문단 스타일(hh:style type="PARA") → 팔레트 엔트리(styleKey ↔ 스타일 id)
 *   - 문자속성(hh:charPr) → 굵게/기울임/밑줄/취소선 마크 맵(charPr id → marks)
 * 를 만든다. 네임스페이스 접두사(hh:)는 문서마다 다를 수 있어 "로컬 이름"으로 매칭한다.
 */
import { parseXml, tagOf, childrenOf, attrOf } from "../core/xml.js";
import type { XmlNode } from "../core/xml.js";
import type { Mark } from "../model/docModel.js";
import type { Palette, PaletteEntry } from "./palette.js";

/** 태그의 로컬 이름(접두사 제거). 예: "hh:charPr" → "charPr". */
function localName(node: XmlNode): string {
  const t = tagOf(node);
  const i = t.indexOf(":");
  return i >= 0 ? t.slice(i + 1) : t;
}

/** 트리 전체에서 로컬 이름이 일치하는 모든 노드를 모은다. */
function collectByLocal(nodes: XmlNode[], local: string, out: XmlNode[] = []): XmlNode[] {
  for (const n of nodes) {
    if (localName(n) === local) out.push(n);
    collectByLocal(childrenOf(n), local, out);
  }
  return out;
}

// ── 문자서식 마크 맵 ────────────────────────────────────────────────────────

/** charPr id → 의미적 마크 집합. (encode 가 굵게/기울임 등을 HTML 로 표현할 때 사용) */
export function parseCharMarks(headerXml: string | undefined): Map<string, Mark[]> {
  const map = new Map<string, Mark[]>();
  if (!headerXml) return map;
  const tree = parseXml(headerXml);
  for (const cp of collectByLocal(tree, "charPr")) {
    const id = attrOf(cp, "id");
    if (id === undefined) continue;
    const marks: Mark[] = [];
    for (const child of childrenOf(cp)) {
      switch (localName(child)) {
        case "bold":
          marks.push("bold");
          break;
        case "italic":
          marks.push("italic");
          break;
        case "underline":
          // type/shape 이 NONE 이면 밑줄 없음
          if ((attrOf(child, "type") ?? "BOTTOM") !== "NONE") marks.push("underline");
          break;
        case "strikeout":
          if ((attrOf(child, "shape") ?? "SOLID") !== "NONE") marks.push("strike");
          break;
      }
    }
    if (marks.length) map.set(id, marks);
  }
  return map;
}

// ── 팔레트 ──────────────────────────────────────────────────────────────────

/** 한글 스타일명 → {styleKey, htmlTag} 휴리스틱. 모르면 undefined. */
function styleKeyFromName(name: string): { key: string; tag: PaletteEntry["htmlTag"] } | undefined {
  const n = name.replace(/\s+/g, "");
  const outline = n.match(/^개요(\d+)$/);
  if (outline) {
    const lvl = Math.min(6, Math.max(1, Number(outline[1])));
    return { key: `heading${lvl}`, tag: `h${lvl}` as PaletteEntry["htmlTag"] };
  }
  if (n === "제목" || n === "title") return { key: "title", tag: "h1" };
  if (n === "바탕글" || n === "본문" || n.toLowerCase() === "normal" || n.toLowerCase() === "body")
    return { key: "body", tag: "p" };
  return undefined;
}

/** CSS class 안전 토큰. 중복은 접미사로 회피. */
function sanitizeKey(base: string, used: Set<string>): string {
  let b = base.replace(/[^A-Za-z0-9_-]/g, "_");
  if (b === "") b = "s";
  let out = b;
  let i = 1;
  while (used.has(out)) out = `${b}_${i++}`;
  used.add(out);
  return out;
}

/**
 * header.xml → 팔레트. PaletteEntry.docxStyleId 에는 hh:style 의 id(=styleIDRef)를 담는다.
 * 본문 hp:p 의 styleIDRef 가 이 id 를 참조하므로 styleKeyFromDocxId 로 매핑된다.
 */
export function buildPaletteFromHwpx(headerXml: string | undefined, id = "hwpx"): Palette {
  const entries: PaletteEntry[] = [];
  const used = new Set<string>();
  let fallback: string | undefined;

  if (headerXml) {
    const tree = parseXml(headerXml);
    for (const st of collectByLocal(tree, "style")) {
      const type = attrOf(st, "type");
      if (type && type.toUpperCase() !== "PARA") continue;
      const styleId = attrOf(st, "id");
      if (styleId === undefined) continue;
      const name = attrOf(st, "name") ?? "";

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
      entries.push({ styleKey, docxStyleId: styleId, htmlTag });
      if (styleKey === "body") fallback = "body";
    }
  }

  if (!fallback) fallback = entries.find((e) => e.styleKey === "body")?.styleKey ?? entries[0]?.styleKey;
  if (!fallback) {
    entries.push({ styleKey: "body", docxStyleId: "0", htmlTag: "p" });
    fallback = "body";
  }
  return { id, entries, fallbackStyleKey: fallback };
}
