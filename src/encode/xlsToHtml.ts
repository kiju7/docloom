/**
 * encode: xls(Excel 97-2003 바이너리/BIFF8/CFB) → 편집용 HTML + Manifest.
 *
 * docloom 철학: 원본 바이트는 통째로 manifest 에 보관하고(originalParts["__source__"]),
 * decode 는 그걸 다시 읽어 텍스트 셀 레코드만 갈아끼운다.
 *
 * HTML 은 시트별 그리드(table). 텍스트 셀(LABELSST/LABEL)만 편집 가능하며,
 * 각 텍스트 셀은 안정적 주소 data-cell="<sheetIdx>!<A1>" 을 갖는다(시트 index 사용 →
 * 시트명 중복에 견고). 숫자/수식 셀은 data-ro 로 표시해 decode 가 건너뛴다.
 */
import type { Manifest } from "../model/manifest.js";
import { readCfb } from "../core/cfb.js";
import { parseWorkbook, a1, colLetter, type Sheet, type ParsedCell } from "../formats/xls-biff.js";
import { toPreviewHtml, type PreviewOptions } from "../preview/preview.js";

/** 원본 .xls 컨테이너 바이트를 manifest.originalParts 에 담는 키. */
export const XLS_SOURCE_KEY = "__source__";

const MAX_ROWS = 400;
const MAX_COLS = 64;
const ROWHEAD_PX = 42;
const DEFAULT_COL_PX = 64;

export interface EncodeXlsResult {
  html: string;
  manifest: Manifest;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderSheet(sheetIdx: number, s: Sheet): string {
  const rows = Math.min(s.maxRow + 1, MAX_ROWS);
  const cols = Math.min(s.maxCol + 1, MAX_COLS);

  // (row,col) → 셀 메타 조회표.
  const byPos = new Map<string, ParsedCell>();
  for (const c of s.cells) byPos.set(`${c.row},${c.col}`, c);

  let cg = `<col style="width:${ROWHEAD_PX}px" />`;
  for (let c = 0; c < cols; c++) cg += `<col style="width:${DEFAULT_COL_PX}px" />`;

  let head = `<tr><th class="xlsx-corner"></th>`;
  for (let c = 0; c < cols; c++) head += `<th class="xlsx-colh">${colLetter(c)}</th>`;
  head += `</tr>`;

  let body = "";
  for (let r = 0; r < rows; r++) {
    let tds = `<th class="xlsx-rowh">${r + 1}</th>`;
    for (let c = 0; c < cols; c++) {
      const cell = byPos.get(`${r},${c}`);
      const addr = `${sheetIdx}!${a1(r, c)}`;
      if (cell && cell.editable) {
        tds += `<td data-cell="${addr}">${esc(cell.text)}</td>`;
      } else if (cell) {
        // 숫자/수식: 읽기 전용.
        tds += `<td data-cell="${addr}" data-ro>${esc(cell.text)}</td>`;
      } else {
        tds += `<td data-cell="${addr}" data-ro></td>`;
      }
    }
    body += `<tr>${tds}</tr>`;
  }
  return `<table class="xlsx-grid" data-sheet="${sheetIdx}"><colgroup>${cg}</colgroup><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

export function encodeXlsToHtml(bytes: Uint8Array, opts: PreviewOptions = {}): EncodeXlsResult {
  const cfb = readCfb(bytes);
  const wbBytes = cfb.streams["Workbook"] ?? cfb.streams["Book"];
  if (!wbBytes) {
    throw new Error("[docloom] xls encode: Workbook/Book 스트림을 찾지 못했습니다.");
  }
  const wb = parseWorkbook(wbBytes);

  const sections = wb.sheets
    .map((s, idx) => {
      const truncated = s.maxRow + 1 > MAX_ROWS || s.maxCol + 1 > MAX_COLS;
      const note = truncated
        ? `<div class="xlsx-note">⚠ 편집 상한(${MAX_ROWS}행 × ${MAX_COLS}열)까지만 표시</div>`
        : "";
      return `<section class="xlsx-sheet" data-sheet-name="${esc(s.name)}"><h2>${esc(s.name)}</h2><div class="xlsx-scroll">${renderSheet(idx, s)}</div>${note}</section>`;
    })
    .join("\n");

  const css = `
  body { padding: 24px; }
  .xlsx-sheet { margin: 0 0 28px; }
  .xlsx-sheet h2 { font-size: 15px; margin: 0 0 8px; color:#1f2937; }
  .xlsx-scroll { overflow:auto; max-width:100%; border:1px solid #c9ccd1; border-radius:6px; background:#fff; }
  .xlsx-grid { border-collapse: collapse; table-layout: fixed; font-size: 11pt; color:#1a1a1a; }
  .xlsx-grid th, .xlsx-grid td { border:1px solid #e1e3e8; padding:2px 6px; overflow:hidden;
    white-space:nowrap; text-overflow:ellipsis; vertical-align:middle; }
  .xlsx-grid td[data-ro] { color:#374151; background:#fafafa; }
  .xlsx-colh, .xlsx-rowh, .xlsx-corner { background:#f3f4f6; color:#6b7280; font-weight:600;
    text-align:center; font-size:11px; }
  .xlsx-note { font-size:11.5px; color:#9aa0a6; margin-top:6px; }
  `;
  const html = toPreviewHtml(`<div class="xlsx-wrap">${sections}</div>`, {
    ...opts,
    css: (opts.css ?? "") + css,
  });

  const manifest: Manifest = {
    version: 1,
    format: "xls",
    container: "cfb",
    originalParts: { [XLS_SOURCE_KEY]: bytes },
    frozen: {},
    props: {},
    paletteId: "xls",
  };

  return { html, manifest };
}
