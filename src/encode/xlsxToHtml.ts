/**
 * encode: xlsx → 편집/왕복용 HTML + Manifest
 *
 * 파이프라인
 *   1) zip 해제 → originalParts (전부 그대로 Manifest 에 보관)
 *   2) 시트별로 <table> 하나씩 — 각 셀에 안정적 주소(data-cell="Sheet!A1")를 단다.
 *   3) 공유 문자열(sharedStrings)은 텍스트로 해석해 넣는다.
 *   4) 서식(스타일·병합·이미지)은 originalParts 에 그대로 살아 있으므로
 *      편집 HTML 엔 인라인스타일을 넣지 않는다(깨끗한 편집 표면).
 *
 * decode 는 이 HTML 의 data-cell 값만 읽어 원본 sheetN.xml 의 해당 <c> 만 교체한다.
 */
import type { Manifest } from "../model/manifest.js";
import { readZip, tryPartToText } from "../core/zip.js";
import { parseXml, collectDeep, deepText, childrenOf, findChild, findChildren, attrOf } from "../core/xml.js";

export interface XlsxEncodeOptions {
  /** 미사용(인터페이스 호환용). */
  _reserved?: never;
}

export interface XlsxEncodeResult {
  html: string;
  manifest: Manifest;
}

/** sharedStrings.xml → 문자열 배열. */
function readSharedStrings(parts: Record<string, Uint8Array>): string[] {
  const xml = tryPartToText(parts, "xl/sharedStrings.xml");
  if (!xml) return [];
  return collectDeep(parseXml(xml), "si").map((si) =>
    collectDeep([si], "t").map(deepText).join(""),
  );
}

/** A1 표기 → 0-기준 {row,col}. */
function parseRef(ref: string): { row: number; col: number } {
  const m = /^([A-Za-z]+)(\d+)$/.exec(ref.trim());
  if (!m) return { row: 0, col: 0 };
  let c = 0;
  for (const ch of m[1]!.toUpperCase()) c = c * 26 + (ch.charCodeAt(0) - 64);
  return { row: Number(m[2]) - 1, col: c - 1 };
}

/** 워크북에서 시트 이름 + 대상 경로(순서대로). */
function sheetList(parts: Record<string, Uint8Array>): { name: string; path: string }[] {
  const wb = tryPartToText(parts, "xl/workbook.xml");
  const names: string[] = [];
  if (wb) for (const s of collectDeep(parseXml(wb), "sheet")) names.push(attrOf(s, "name") ?? `Sheet${names.length + 1}`);
  const paths = Object.keys(parts)
    .filter((p) => /^xl\/worksheets\/sheet\d+\.xml$/.test(p))
    .sort((a, b) => sheetNum(a) - sheetNum(b));
  return paths.map((path, i) => ({ name: names[i] ?? `Sheet${i + 1}`, path }));
}
const sheetNum = (p: string): number => Number(/sheet(\d+)\.xml$/.exec(p)?.[1] ?? 0);

interface CellText { ref: string; row: number; col: number; text: string }

/** 한 시트 XML → 셀(주소+텍스트) 목록과 사용 범위. */
function sheetCells(xml: string, shared: string[]): { cells: CellText[]; rows: number; cols: number } {
  const tree = parseXml(xml);
  const cells: CellText[] = [];
  let maxRow = 0;
  let maxCol = 0;

  for (const row of collectDeep(tree, "row")) {
    for (const c of findChildren(childrenOf(row), "c")) {
      const ref = attrOf(c, "r") ?? "A1";
      const { row: r, col } = parseRef(ref);
      const type = attrOf(c, "t");
      const v = findChild(childrenOf(c), "v");
      const isNode = findChild(childrenOf(c), "is");
      let text = "";
      if (type === "s" && v) text = shared[Number(deepText(v))] ?? "";
      else if (type === "inlineStr" && isNode) text = deepText(isNode);
      else if (v) text = deepText(v);
      else if (isNode) text = deepText(isNode);
      cells.push({ ref, row: r, col, text });
      if (r > maxRow) maxRow = r;
      if (col > maxCol) maxCol = col;
    }
  }

  // dimension 으로 사용 범위 보강(빈 셀 자리 보존)
  const dim = collectDeep(tree, "dimension")[0];
  if (dim) {
    const end = (attrOf(dim, "ref") ?? "").split(":")[1];
    if (end) {
      const e = parseRef(end);
      if (e.row > maxRow) maxRow = e.row;
      if (e.col > maxCol) maxCol = e.col;
    }
  }
  return { cells, rows: maxRow + 1, cols: maxCol + 1 };
}

/** 0-기준 열 index → 열 문자(A, B, …). */
function colLetter(idx0: number): string {
  let s = "";
  let n = idx0 + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escAttr(s: string): string {
  return esc(s).replace(/"/g, "&quot;");
}

export function encodeXlsxToHtml(bytes: Uint8Array, _opts: XlsxEncodeOptions = {}): XlsxEncodeResult {
  const originalParts = readZip(bytes);
  const shared = readSharedStrings(originalParts);

  const sections = sheetList(originalParts)
    .map(({ name, path }) => {
      const { cells, rows, cols } = sheetCells(tryPartToText(originalParts, path) ?? "", shared);
      // 주소 → 텍스트 맵 (빈 셀 자리 보존을 위해 그리드 전체를 그린다)
      const byKey = new Map<string, string>();
      for (const c of cells) byKey.set(`${c.row},${c.col}`, c.text);

      let body = "";
      for (let r = 0; r < rows; r++) {
        let tds = "";
        for (let c = 0; c < cols; c++) {
          const addr = `${name}!${colLetter(c)}${r + 1}`;
          const txt = byKey.get(`${r},${c}`) ?? "";
          tds += `<td data-cell="${escAttr(addr)}">${esc(txt)}</td>`;
        }
        body += `<tr>${tds}</tr>`;
      }
      return `<section class="xlsx-sheet" data-sheet="${escAttr(name)}"><h2>${esc(name)}</h2><table class="xlsx-edit"><tbody>${body}</tbody></table></section>`;
    })
    .join("\n");

  const html = `<div class="xlsx-doc">\n${sections}\n</div>`;

  const manifest: Manifest = {
    version: 1,
    originalParts,
    format: "xlsx",
    container: "zip",
    frozen: {},
    props: {},
    paletteId: "xlsx",
  };

  return { html, manifest };
}
