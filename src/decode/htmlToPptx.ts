/**
 * decode: 편집된 HTML + Manifest → pptx (양식 보존 왕복)
 *
 * 철학: 원본 part 는 전부 그대로 두고(originalParts), 슬라이드 XML 의 a:t "텍스트"만
 * 편집본으로 교체한다. a:rPr(런 서식)·도형 xfrm(위치/크기)·표 구조·이미지·레이아웃은
 * 원본 XML 노드를 그대로 유지하므로 절대 깨지지 않는다.
 *
 *   1) HTML 파싱 → data-run 식별자별 새 텍스트 맵 구성
 *      ("<slidePath>|<shapePath>|p<pi>|r<ri>" → 편집된 문자열)
 *   2) 슬라이드 XML 을 encode 와 동일 규칙으로 순회하며 매칭되는 a:r 의 a:t 텍스트만 교체
 *      - 편집 후 사라진 런(span 삭제)은 a:t 를 빈 문자열로
 *      - 매핑에 없는(편집에서 누락된) 런은 원본 유지(보수적)
 *   3) 나머지 part 는 손대지 않고 슬라이드 XML 만 교체 → 재 zip
 *
 * 식별 스킴·순회 규칙은 encode/pptxToHtml.ts 와 1:1 대응한다.
 */
import type { Manifest } from "../model/manifest.js";
import { writeZip, partToText, textToPart } from "../core/zip.js";
import {
  parseXml,
  buildXml,
  tagOf,
  textOf,
  childrenOf,
  findChild,
  findChildren,
  findDeep,
  attrOf,
  setChildren,
  makeTextNode,
  type XmlNode,
} from "../core/xml.js";

export interface PptxDecodeOptions {
  [k: string]: unknown;
}

export function decodeHtmlToPptx(html: string, manifest: Manifest, _opts: PptxDecodeOptions = {}): Uint8Array {
  // 편집된 HTML 에서 run-id → 새 텍스트 맵 수집
  const edits = collectEdits(parseXml(html));

  const slidePaths: string[] = JSON.parse(manifest.native?.slidePaths ?? "[]");
  const parts: Record<string, Uint8Array> = { ...manifest.originalParts };

  for (const slidePath of slidePaths) {
    if (!manifest.originalParts[slidePath]) continue;
    const doc = parseXml(partToText(manifest.originalParts, slidePath));
    const spTree = findDeep(doc, "p:spTree");
    if (!spTree) continue;
    applyShapes(childrenOf(spTree), slidePath, "", edits);
    parts[slidePath] = textToPart(buildXml(doc));
  }

  return writeZip(parts);
}

// ── HTML → 편집 맵 ────────────────────────────────────────────────────────────

/** data-run 식별자 → 편집된 텍스트. 트리 전체에서 span[data-run] 을 수집. */
function collectEdits(nodes: XmlNode[], out: Map<string, string> = new Map()): Map<string, string> {
  for (const n of nodes) {
    const runId = attrOf(n, "data-run");
    if (runId !== undefined) {
      out.set(runId, innerText(n));
      continue; // 런 내부는 평문만 — 더 내려가지 않음
    }
    collectEdits(childrenOf(n), out);
  }
  return out;
}

/** 노드 하위의 모든 #text 를 이어붙인다(br 은 줄바꿈으로 — pptx 런 안에선 드묾). */
function innerText(node: XmlNode): string {
  let s = "";
  for (const c of childrenOf(node)) {
    if (tagOf(c) === "#text") s += textOf(c) ?? "";
    else if (tagOf(c) === "br") s += "\n";
    else s += innerText(c);
  }
  return s;
}

// ── 슬라이드 XML 순회 (encode 와 동일 규칙) ───────────────────────────────────

function applyShapes(nodes: XmlNode[], slidePath: string, prefix: string, edits: Map<string, string>): void {
  nodes.forEach((node, idx) => {
    const tag = tagOf(node);
    const path = prefix ? `${prefix}.${idx}` : `${idx}`;
    if (tag === "p:grpSp") {
      applyShapes(childrenOf(node), slidePath, path, edits);
      return;
    }
    if (tag === "p:sp") {
      const tx = findChild(childrenOf(node), "p:txBody");
      if (tx) applyTxBody(tx, `${slidePath}|${path}`, edits);
      return;
    }
    if (tag === "p:graphicFrame") {
      const tbl = findDeep([node], "a:tbl");
      if (tbl) applyTable(tbl, slidePath, path, edits);
    }
  });
}

function applyTable(tbl: XmlNode, slidePath: string, shapePath: string, edits: Map<string, string>): void {
  const trs = findChildren(childrenOf(tbl), "a:tr");
  trs.forEach((tr, ri) => {
    findChildren(childrenOf(tr), "a:tc").forEach((tc, ci) => {
      const tx = findChild(childrenOf(tc), "a:txBody");
      if (tx) applyTxBody(tx, `${slidePath}|${shapePath}.tc${ri}.${ci}`, edits);
    });
  });
}

/** txBody 안 a:p/a:r 를 순회하며 매칭 런의 a:t 텍스트를 교체. */
function applyTxBody(txBody: XmlNode, base: string, edits: Map<string, string>): void {
  const ps = findChildren(childrenOf(txBody), "a:p");
  ps.forEach((p, pi) => {
    let ri = 0;
    for (const n of childrenOf(p)) {
      if (tagOf(n) !== "a:r") continue;
      const id = `${base}|p${pi}|r${ri}`;
      ri++;
      if (!edits.has(id)) continue; // 편집에서 누락 → 원본 유지(보수적)
      setRunText(n, edits.get(id)!);
    }
  });
}

/** a:r 의 a:t 텍스트 노드만 교체. a:rPr 등 다른 자식은 그대로. a:t 없으면 새로 추가. */
function setRunText(run: XmlNode, text: string): void {
  let t = findChild(childrenOf(run), "a:t");
  if (!t) {
    t = { "a:t": [] as XmlNode[] };
    childrenOf(run).push(t);
  }
  setChildren(t, [makeTextNode(text)]);
  // 공백 보존: 앞뒤 공백이 있으면 xml:space="preserve" 부여
  if (/^\s|\s$/.test(text)) {
    const at = (t[":@"] ?? (t[":@"] = {})) as Record<string, unknown>;
    at["@_xml:space"] = "preserve";
  }
}
