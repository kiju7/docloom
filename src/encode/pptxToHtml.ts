/**
 * encode: pptx → 편집용 HTML + Manifest (왕복용)
 *
 * 철학(docx 와 동일): 원본 모든 part 를 manifest.originalParts 에 그대로 보관하고,
 * HTML 에는 "편집 가능한 텍스트 런"만 안정적 식별자와 함께 내보낸다. decode 는
 * 슬라이드 XML 을 다시 파싱해 같은 식별자의 a:t 텍스트만 교체한다 → 위치·서식·
 * 이미지·표 구조·레이아웃은 절대 깨지지 않는다.
 *
 * ── 런 식별 스킴 (per-run 매핑) ───────────────────────────────────────────────
 *   data-run = "<slidePath>|<shapePath>|p<문단idx>|r<런idx>"
 *     - slidePath  : zip 안 슬라이드 경로 (예: "ppt/slides/slide1.xml")
 *     - shapePath  : spTree 기준 도형 위치 경로. 자식 인덱스를 점으로 이은 값
 *                    (그룹/표 안으로 재귀). 예: "2" 또는 "1.0" (그룹 안 첫 도형).
 *     - p<idx>     : 도형 txBody 안 a:p 의 0-based 인덱스
 *     - r<idx>     : 그 문단 안 "텍스트 런(a:r)"의 0-based 인덱스
 *   decode 는 원본 XML 을 같은 규칙으로 순회하므로 인덱스만으로 정확히 되찾는다.
 *   런 단위로 매핑하므로 a:rPr(색·크기·볼드 등 런 서식)이 자연히 보존된다.
 *   표 셀 텍스트도 같은 스킴을 쓴다(graphicFrame 도형 → a:tbl 셀 안 txBody).
 */
import type { Manifest } from "../model/manifest.js";
import { readZip, tryPartToText } from "../core/zip.js";
import {
  parseXml,
  tagOf,
  childrenOf,
  findChild,
  findChildren,
  findDeep,
  attrOf,
  deepText,
  type XmlNode,
} from "../core/xml.js";

export interface PptxEncodeOptions {
  /** 미사용(향후 팔레트 등). 시그니처 호환용. */
  [k: string]: unknown;
}

export interface PptxEncodeResult {
  html: string;
  manifest: Manifest;
}

// ── 슬라이드 순서 (pptx.ts 의 로직과 동일) ────────────────────────────────────

function resolvePath(fromPart: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const out: string[] = [];
  for (const seg of (fromPart.split("/").slice(0, -1).join("/") + "/" + target).split("/")) {
    if (seg === "..") out.pop();
    else if (seg !== "." && seg !== "") out.push(seg);
  }
  return out.join("/");
}
function relsPathFor(part: string): string {
  const i = part.lastIndexOf("/");
  return `${part.slice(0, i)}/_rels${part.slice(i)}.rels`;
}
function readRelTargets(parts: Record<string, Uint8Array>, relsPath: string): { id: string; target: string }[] {
  const out: { id: string; target: string }[] = [];
  const xml = tryPartToText(parts, relsPath);
  if (!xml) return out;
  for (const rel of collectRelationships(parseXml(xml))) {
    const id = attrOf(rel, "Id");
    const t = attrOf(rel, "Target");
    if (id && t) out.push({ id, target: t });
  }
  return out;
}
function collectRelationships(nodes: XmlNode[], out: XmlNode[] = []): XmlNode[] {
  for (const n of nodes) {
    if (tagOf(n) === "Relationship") out.push(n);
    collectRelationships(childrenOf(n), out);
  }
  return out;
}

export function slidePaths(parts: Record<string, Uint8Array>): string[] {
  const pres = tryPartToText(parts, "ppt/presentation.xml");
  const rels = new Map(readRelTargets(parts, "ppt/_rels/presentation.xml.rels").map((r) => [r.id, r.target]));
  if (pres) {
    const ordered = collectDeepTag(parseXml(pres), "p:sldId")
      .map((n) => attrOf(n, "r:id"))
      .map((id) => (id ? rels.get(id) : undefined))
      .filter((t): t is string => !!t)
      .map((t) => resolvePath("ppt/presentation.xml", t));
    if (ordered.length) return ordered;
  }
  return Object.keys(parts)
    .filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
    .sort((a, b) => Number(/slide(\d+)/.exec(a)![1]) - Number(/slide(\d+)/.exec(b)![1]));
}
function collectDeepTag(nodes: XmlNode[], tag: string, out: XmlNode[] = []): XmlNode[] {
  for (const n of nodes) {
    if (tagOf(n) === tag) out.push(n);
    collectDeepTag(childrenOf(n), tag, out);
  }
  return out;
}

// ── 식별자 (encode/decode 공유) ───────────────────────────────────────────────

/** 도형(p:sp / p:graphicFrame …) 의 txBody 들을 (path,txBody) 로 나열. 그룹/표 재귀. */
export interface ShapeText {
  shapePath: string;
  txBody: XmlNode;
}

const ESC = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// ── HTML 직렬화 ───────────────────────────────────────────────────────────────

/** 한 txBody → 편집용 HTML 문단들. base = "<slidePath>|<shapePath>". */
function renderTxBody(txBody: XmlNode, base: string): string {
  const ps = findChildren(childrenOf(txBody), "a:p");
  let out = "";
  ps.forEach((p, pi) => {
    let inner = "";
    let ri = 0;
    for (const n of childrenOf(p)) {
      const tag = tagOf(n);
      if (tag === "a:r") {
        const t = findChild(childrenOf(n), "a:t");
        const text = t ? deepText(t) : "";
        const id = `${base}|p${pi}|r${ri}`;
        inner += `<span data-run="${ESC(id)}">${ESC(text)}</span>`;
        ri++;
      } else if (tag === "a:br") {
        inner += "<br/>";
      }
      // a:fld(자동 필드: 슬라이드 번호·날짜 등)는 편집 대상에서 제외(원본 그대로 보존).
    }
    out += `<p data-para="${ESC(base + "|p" + pi)}">${inner || "&#8203;"}</p>`;
  });
  return out;
}

/** spTree 자식들을 순회하며 텍스트가 있는 도형을 HTML 로. shapePath 는 인덱스 경로. */
function renderShapes(nodes: XmlNode[], slidePath: string, prefix: string): string {
  let out = "";
  nodes.forEach((node, idx) => {
    const tag = tagOf(node);
    const path = prefix ? `${prefix}.${idx}` : `${idx}`;
    if (tag === "p:grpSp") {
      out += renderShapes(childrenOf(node), slidePath, path);
      return;
    }
    if (tag === "p:sp") {
      const tx = findChild(childrenOf(node), "p:txBody");
      if (tx && findChildren(childrenOf(tx), "a:p").length) {
        const body = renderTxBody(tx, `${slidePath}|${path}`);
        out += `<div class="pptx-sp" data-shape="${ESC(slidePath + "|" + path)}">${body}</div>`;
      }
      return;
    }
    if (tag === "p:graphicFrame") {
      const tbl = findDeep([node], "a:tbl");
      if (tbl) {
        out += renderTable(tbl, slidePath, path);
      }
    }
  });
  return out;
}

/** a:tbl → 편집용 표. 셀 식별자는 도형 경로에 "tc<row>.<col>" 를 덧붙인다. */
function renderTable(tbl: XmlNode, slidePath: string, shapePath: string): string {
  const trs = findChildren(childrenOf(tbl), "a:tr");
  let rows = "";
  trs.forEach((tr, ri) => {
    let cells = "";
    const tcs = findChildren(childrenOf(tr), "a:tc");
    tcs.forEach((tc, ci) => {
      const tx = findChild(childrenOf(tc), "a:txBody");
      const cellPath = `${shapePath}.tc${ri}.${ci}`;
      const body = tx ? renderTxBody(tx, `${slidePath}|${cellPath}`) : "&#8203;";
      cells += `<td data-cell="${ESC(slidePath + "|" + cellPath)}">${body}</td>`;
    });
    rows += `<tr>${cells}</tr>`;
  });
  return `<table class="pptx-tbl" data-shape="${ESC(slidePath + "|" + shapePath)}"><tbody>${rows}</tbody></table>`;
}

export function encodePptxToHtml(bytes: Uint8Array, _opts: PptxEncodeOptions = {}): PptxEncodeResult {
  const originalParts = readZip(bytes);
  const paths = slidePaths(originalParts);

  const sections: string[] = [];
  paths.forEach((slidePath, i) => {
    const xml = tryPartToText(originalParts, slidePath);
    if (!xml) return;
    const spTree = findDeep(parseXml(xml), "p:spTree");
    const shapes = spTree ? renderShapes(childrenOf(spTree), slidePath, "") : "";
    sections.push(
      `<section class="pptx-slide" data-slide="${ESC(slidePath)}"><h2 class="pptx-slide-no">슬라이드 ${i + 1}</h2>${shapes}</section>`,
    );
  });

  const html = `<div class="docloom-pptx">\n${sections.join("\n")}\n</div>`;
  const manifest: Manifest = {
    version: 1,
    format: "pptx",
    container: "zip",
    originalParts,
    frozen: {},
    props: {},
    paletteId: "pptx-passthrough",
    native: { slidePaths: JSON.stringify(paths) },
  };
  return { html, manifest };
}
