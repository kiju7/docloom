/**
 * xls 포맷 어댑터 — Excel 97-2003 바이너리(BIFF8/CFB)의 미리보기(읽기) 전용 구현.
 *
 * .xls 는 zip 이 아니라 OLE2/CFB 복합문서다. 워크북 본문은 "Workbook" 스트림(아주 오래된
 * 파일은 "Book")에 BIFF8 레코드 스트림으로 담긴다. 각 레코드는:
 *   [2B type LE][2B length LE][data...]
 * 길이가 한 레코드 한도(8224B)를 넘는 SST 등은 CONTINUE(0x003C) 레코드로 이어진다.
 *
 * 이 어댑터가 추출하는 것(미리보기 목적의 부분 충실도):
 *   - BOUNDSHEET(0x0085): 시트 이름 + 워크북 글로벌 substream 기준 BOF 절대 오프셋
 *   - SST(0x00FC): 공유 문자열 풀(Unicode string: 2B charCount, 1B grbit; bit0=16bit chars,
 *                  bit2=phonetic(far east), bit3=rich text). CONTINUE 경계에서 문자열이
 *                  쪼개질 때 각 CONTINUE 조각의 선두 1B grbit 로 16/8bit 가 다시 표시된다.
 *   - 셀 레코드: LABELSST(0x00FD), LABEL(0x0204), NUMBER(0x0203), RK(0x027E), MULRK(0x00BD)
 *
 * 한계(아직 미지원): 수식(FORMULA) 결과·셀 서식/숫자포맷·테두리/색·병합·이미지·왕복.
 *   숫자는 원시값을 그대로 문자열화한다(통화/날짜 서식 미적용). 왕복(encode/decode)은 로드맵.
 */
import type { FormatAdapter } from "../core/format.js";
import type { Manifest } from "../model/manifest.js";
import { readCfb } from "../core/cfb.js";
import { toPreviewHtml, type PreviewOptions } from "../preview/preview.js";
import { parseWorkbook, colLetter, type Sheet } from "./xls-biff.js";
import { encodeXlsToHtml } from "../encode/xlsToHtml.js";
import { decodeHtmlToXls } from "../decode/htmlToXls.js";

// 미리보기 폭주 방지 상한(원본이 더 커도 여기까지만 그린다).
const MAX_ROWS = 400;
const MAX_COLS = 64;

// ── HTML 렌더(xlsx.ts 그리드 룩앤필 재사용) ──────────────────────────────────

const ROWHEAD_PX = 42;
const DEFAULT_COL_PX = 64;

function renderSheet(s: Sheet): string {
  const rows = Math.min(s.maxRow + 1, MAX_ROWS);
  const cols = Math.min(s.maxCol + 1, MAX_COLS);

  const value = new Map<string, string>();
  for (const c of s.cells) value.set(`${c.row},${c.col}`, c.text);

  let cg = `<col style="width:${ROWHEAD_PX}px" />`;
  for (let c = 0; c < cols; c++) cg += `<col style="width:${DEFAULT_COL_PX}px" />`;

  let head = `<tr><th class="xlsx-corner"></th>`;
  for (let c = 0; c < cols; c++) head += `<th class="xlsx-colh">${colLetter(c)}</th>`;
  head += `</tr>`;

  let body = "";
  for (let r = 0; r < rows; r++) {
    let tds = `<th class="xlsx-rowh">${r + 1}</th>`;
    for (let c = 0; c < cols; c++) tds += `<td>${esc(value.get(`${r},${c}`) ?? "")}</td>`;
    body += `<tr>${tds}</tr>`;
  }
  return `<table class="xlsx-grid"><colgroup>${cg}</colgroup><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

export function xlsToPreviewHtml(bytes: Uint8Array, opts: PreviewOptions = {}): string {
  const cfb = readCfb(bytes);
  const wbBytes = cfb.streams["Workbook"] ?? cfb.streams["Book"];
  if (!wbBytes) {
    return toPreviewHtml(
      `<div class="xlsx-wrap"><p>이 .xls 에서 Workbook/Book 스트림을 찾지 못했습니다.</p></div>`,
      opts,
    );
  }
  const wb = parseWorkbook(wbBytes);

  const body = wb.sheets
    .map((s) => {
      const truncated = s.maxRow + 1 > MAX_ROWS || s.maxCol + 1 > MAX_COLS;
      const note = truncated
        ? `<div class="xlsx-note">⚠ 미리보기 상한(${MAX_ROWS}행 × ${MAX_COLS}열)까지만 표시</div>`
        : "";
      return `<section class="xlsx-sheet"><h2>${esc(s.name)}</h2><div class="xlsx-scroll">${renderSheet(s)}</div>${note}</section>`;
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
  .xlsx-colh, .xlsx-rowh, .xlsx-corner { background:#f3f4f6; color:#6b7280; font-weight:600;
    text-align:center; font-size:11px; }
  .xlsx-note { font-size:11.5px; color:#9aa0a6; margin-top:6px; }
  `;
  return toPreviewHtml(`<div class="xlsx-wrap">${body}</div>`, { ...opts, css: (opts.css ?? "") + css });
}

export const xlsAdapter: FormatAdapter = {
  id: "xls",
  label: "Excel 97-2003 스프레드시트 (.xls)",
  supportsRoundTrip: true,
  /** CFB 라우팅은 컨테이너로 한다(parts 기반 아님). zip part 검출에는 해당 없음 → false. */
  detect() {
    return false;
  },
  encode(bytes, opts) {
    return encodeXlsToHtml(bytes, (opts ?? {}) as PreviewOptions);
  },
  decode(html, manifest, opts) {
    return decodeHtmlToXls(html, manifest as Manifest, opts);
  },
  toPreviewHtml(bytes, opts) {
    return xlsToPreviewHtml(bytes, (opts ?? {}) as PreviewOptions);
  },
};

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
