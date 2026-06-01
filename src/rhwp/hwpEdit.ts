/**
 * rhwp 기반 HWP/HWPX 편집 채널 (opt-in)
 *
 * docloom 코어는 순수 TS(WASM 미사용) 원칙을 지킨다. 이 모듈은 그 예외가 아니라 — rhwp
 * WASM 을 **직접 import 하지 않고**, 호출측이 초기화한 `HwpDocument` 인스턴스를 인자로 받는다.
 * (브라우저 데모는 `@rhwp/core` 를, 테스트는 Node 에서 같은 WASM 을 초기화해 넘긴다.)
 *
 * 왜 rhwp 인가: docloom 자체 순수-TS HWP decode 는 표/각주/이미지 문단을 frozen 으로만
 * 보존해 **표 셀 안 텍스트를 LLM 이 못 읽고 못 고친다**. rhwp 는 표/셀/각주/필드까지 모두
 * 파싱·편집할 수 있어, 양식(별첨 등) 본문을 셀 단위로 노출·수정할 수 있다.
 *
 * 흐름: `hwpToEditableHtml(doc)` → (LLM/사람이 HTML 텍스트 편집) → `applyHwpEdits(doc, html)`
 * → 호출측이 `doc.exportHwpx()` 로 편집된 바이트를 얻는다.
 *   - ⚠ rhwp 의 `exportHwp()`(.hwp 저장)는 무편집에도 깨지는 버그가 있어 쓰지 않는다.
 *     **반드시 `exportHwpx()`(HWPX)** 로 내보낸다. .hwp 입력이어도 복원물은 .hwpx.
 *   - v1 범위: 텍스트 내용 편집(평문 문단 + 표 셀). 문단/행/열 추가·삭제, 인라인 서식 토글,
 *     이미지/수식 내용 편집은 범위 밖(자리표시자로 보존만).
 */
import { parse, type HTMLElement } from "node-html-parser";
import { bytesToBase64 } from "../core/base64.js";
import { extractHwpBinImages } from "../preview/hwpRender.js";

/** rhwp `HwpDocument` 에서 이 모듈이 쓰는 메서드만 추린 구조적 타입. */
export interface RhwpDoc {
  getDocumentInfo(): string;
  getParagraphCount(section: number): number;
  getParagraphLength(section: number, para: number): number;
  getTextRange(section: number, para: number, offset: number, count: number): string;
  getControlTextPositions(section: number, para: number): string;
  getTableDimensions(section: number, para: number, control: number): string;
  getCellParagraphCount(section: number, para: number, control: number, cell: number): number;
  getCellParagraphLength(section: number, para: number, control: number, cell: number, cellPara: number): number;
  getTextInCell(
    section: number, para: number, control: number, cell: number, cellPara: number, offset: number, count: number,
  ): string;
  replaceText(section: number, para: number, offset: number, length: number, text: string): string;
  deleteTextInCell(
    section: number, para: number, control: number, cell: number, cellPara: number, offset: number, count: number,
  ): string;
  insertTextInCell(
    section: number, para: number, control: number, cell: number, cellPara: number, offset: number, text: string,
  ): string;
  getControlImageMime?(section: number, para: number, control: number): string;
  // ── 리치 미리보기(hwpToRichPreviewHtml)용 — rhwp 의 정확한 스타일/이미지/용지 데이터 ──
  getPageDef?(section: number): string;
  getParaPropertiesAt?(section: number, para: number): string;
  getCharPropertiesAt?(section: number, para: number, charOffset: number): string;
  getCellProperties?(section: number, para: number, control: number, cell: number): string;
  getCellInfo?(section: number, para: number, control: number, cell: number): string;
  getCellParaPropertiesAt?(section: number, para: number, control: number, cell: number, cellPara: number): string;
  getCellCharPropertiesAt?(
    section: number, para: number, control: number, cell: number, cellPara: number, charOffset: number,
  ): string;
  getControlImageData?(section: number, para: number, control: number): Uint8Array;
  getPictureProperties?(section: number, para: number, control: number): string;
  getPageOfPosition?(section: number, para: number): string;
  /** 페이지에 앵커된 floating 그림. 현 WASM 빌드는 imageCount 만 채우고 항목은 비울 수 있음. */
  getPageOverlayImages?(page: number): string;
  /** 페이지 위 컨트롤(표·그림 등)의 레이아웃 좌표/크기(px). 그림은 type:"image" + x/y/w/h. */
  getPageControlLayout?(page: number): string;
  getHeaderFooter?(section: number, isHeader: boolean, applyTo: number): string;
  getParaPropertiesInHf?(section: number, isHeader: boolean, applyTo: number, hfParaIdx: number): string;
  // 하이브리드 미리보기(hwpToHybridPreviewHtml)용 — rhwp 의 SVG 렌더.
  pageCount?(): number;
  renderPageSvg?(page: number): string;
  // 충실 미리보기(hwpToFaithfulPreviewHtml)용 — rhwp 의 HTML 렌더(이미지·표·텍스트 절대배치, 자립형).
  renderPageHtml?(page: number): string;
}

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** rhwp JSON 반환을 안전 파싱(실패 시 null). */
function pj<T = any>(s: string | undefined): T | null {
  if (typeof s !== "string") return null;
  try { return JSON.parse(s) as T; } catch { return null; }
}

function sectionCount(doc: RhwpDoc): number {
  const info = pj<{ sectionCount?: number }>(safe(() => doc.getDocumentInfo()));
  return Math.max(1, info?.sectionCount ?? 1);
}

/** 던지는 rhwp 호출을 감싸 undefined 로 떨군다(한 컨트롤 실패가 전체를 깨지 않게). */
function safe<T>(fn: () => T): T | undefined {
  try { return fn(); } catch { return undefined; }
}

/** 한 문단의 컨트롤들 중 "표"인 것의 control_idx + 차원을 찾는다. */
function tablesInPara(doc: RhwpDoc, s: number, p: number): Array<{ ci: number; rows: number; cols: number; cells: number }> {
  const positions = pj<number[]>(safe(() => doc.getControlTextPositions(s, p))) ?? [];
  const out: Array<{ ci: number; rows: number; cols: number; cells: number }> = [];
  for (let ci = 0; ci < positions.length; ci++) {
    const dim = pj<{ rowCount: number; colCount: number; cellCount: number }>(
      safe(() => doc.getTableDimensions(s, p, ci)),
    );
    if (dim && dim.cellCount > 0) out.push({ ci, rows: dim.rowCount, cols: dim.colCount, cells: dim.cellCount });
  }
  return out;
}

/**
 * rhwp 문서 → 편집용 HTML.
 * 편집 가능한 텍스트마다 앵커를 단다: 평문 문단 `data-h="s,p"`, 표 셀 문단
 * `data-hc="s,p,control,cell,cellPara"`. 표는 `<table data-ht>` 로 구조를 보존한다.
 */
export function hwpToEditableHtml(doc: RhwpDoc): string {
  const secN = sectionCount(doc);
  let body = "";
  for (let s = 0; s < secN; s++) {
    const pc = safe(() => doc.getParagraphCount(s)) ?? 0;
    for (let p = 0; p < pc; p++) {
      const tables = tablesInPara(doc, s, p);
      const ctrlCount = (pj<number[]>(safe(() => doc.getControlTextPositions(s, p))) ?? []).length;

      // 평문 문단(컨트롤 없음): 텍스트가 있으면 편집 가능한 <p>
      const plen = safe(() => doc.getParagraphLength(s, p)) ?? 0;
      if (ctrlCount === 0 && plen > 0) {
        const t = safe(() => doc.getTextRange(s, p, 0, plen)) ?? "";
        body += `<p data-h="${s},${p}">${esc(t)}</p>\n`;
      } else if (ctrlCount === 0 && plen === 0) {
        body += `<p data-h="${s},${p}"><br></p>\n`; // 빈 문단(편집 시 채울 수 있게)
      }

      // 표: 셀마다 편집 가능한 문단 노출
      for (const t of tables) {
        body += `<table class="hwp-tbl" data-ht="${s},${p},${t.ci}">\n<tbody>\n`;
        let cell = 0;
        for (let r = 0; r < t.rows && cell < t.cells; r++) {
          body += "<tr>";
          for (let c = 0; c < t.cols && cell < t.cells; c++) {
            const cpc = safe(() => doc.getCellParagraphCount(s, p, t.ci, cell)) ?? 0;
            let inner = "";
            for (let cp = 0; cp < cpc; cp++) {
              const l = safe(() => doc.getCellParagraphLength(s, p, t.ci, cell, cp)) ?? 0;
              const text = l > 0 ? safe(() => doc.getTextInCell(s, p, t.ci, cell, cp, 0, l)) ?? "" : "";
              inner += `<div data-hc="${s},${p},${t.ci},${cell},${cp}">${esc(text) || "<br>"}</div>`;
            }
            if (!inner) inner = "<br>";
            body += `<td>${inner}</td>`;
            cell++;
          }
          body += "</tr>\n";
        }
        body += "</tbody>\n</table>\n";
      }
    }
  }
  return `<div class="hwp-edit" data-hwp-edit="1">\n${body}</div>`;
}

/** "s,p[,…]" 앵커를 정수 배열로. */
function addr(el: HTMLElement, name: string): number[] | null {
  const v = el.getAttribute(name);
  if (!v) return null;
  const parts = v.split(",").map((x) => Number(x));
  return parts.every((n) => Number.isInteger(n)) ? parts : null;
}

/** node-html-parser 의 .text 는 textContent(엔티티 해제)지만 개행을 안 넣음 → 셀/문단별 추출에 적합. */
function norm(s: string): string {
  return s.replace(/ /g, " ").replace(/[\r\n]+/g, " ").trim();
}

function nodeText(el: HTMLElement): string {
  // <br> 만 있는 빈 셀은 빈 문자열로 취급
  const t = el.text;
  return t.replace(/ /g, " ").replace(/[\r\n]+/g, " ").trim();
}

/**
 * 편집된 HTML 을 rhwp 문서에 반영(텍스트 내용만). 변경된 앵커마다 현재 문서값과 비교해 교체.
 * 반환: 실제로 바뀐 노드 수. (이후 호출측이 `doc.exportHwpx()` 로 바이트를 얻는다.)
 *
 * 텍스트 전용 편집이라 문단/셀 인덱스가 안 변해 적용 순서는 무관하다.
 */
export function applyHwpEdits(doc: RhwpDoc, editedHtml: string): number {
  const root = parse(editedHtml, { lowerCaseTagName: true, comment: false });
  let changed = 0;

  // 표 셀 문단
  for (const el of root.querySelectorAll("[data-hc]")) {
    const a = addr(el, "data-hc");
    if (!a || a.length !== 5) continue;
    const [s, p, ci, cell, cp] = a;
    const next = nodeText(el);
    const len = safe(() => doc.getCellParagraphLength(s!, p!, ci!, cell!, cp!)) ?? 0;
    const cur = norm(len > 0 ? safe(() => doc.getTextInCell(s!, p!, ci!, cell!, cp!, 0, len)) ?? "" : "");
    if (cur === next) continue;
    if (len > 0) safe(() => doc.deleteTextInCell(s!, p!, ci!, cell!, cp!, 0, len));
    if (next) safe(() => doc.insertTextInCell(s!, p!, ci!, cell!, cp!, 0, next));
    changed++;
  }

  // 평문 문단
  for (const el of root.querySelectorAll("[data-h]")) {
    const a = addr(el, "data-h");
    if (!a || a.length !== 2) continue;
    const [s, p] = a;
    const next = nodeText(el);
    const len = safe(() => doc.getParagraphLength(s!, p!)) ?? 0;
    const cur = norm(len > 0 ? safe(() => doc.getTextRange(s!, p!, 0, len)) ?? "" : "");
    if (cur === next) continue;
    safe(() => doc.replaceText(s!, p!, 0, len, next));
    changed++;
  }

  return changed;
}

// ─────────────────────────────────────────────────────────────────────────────
// 리치 미리보기: rhwp 의 정확한 데이터(셀 배경·글자속성·정렬·이미지)를 흐르는 HTML 로 렌더.
// rhwp 의 SVG 렌더(renderPageSvg)는 마지막 1칸 표 텍스트를 누락하고 셀 배경이 페이지 경계에서
// 끊긴다(0.7.13 한계). 흐름배치 HTML 은 클리핑/페이지경계가 없어 **모든 내용이 보이고 배경이
// 이어진다**. 픽셀단위 한글 레이아웃 일치는 목표가 아니다(내용 완전 + 양식 가독이 목표).
// ─────────────────────────────────────────────────────────────────────────────

/** HWPUNIT(1/7200인치) → CSS px(96dpi). fontSize(1/100pt)도 같은 /75 로 px 가 된다. */
const hu2px = (hu: number): number => Math.round((hu / 7200) * 96);
/** rhwp 색 문자열(#rrggbb)을 그대로(없거나 흰색 계열이면 undefined). */
function color(v: unknown): string | undefined {
  return typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v) ? v : undefined;
}
const VALIGN = ["top", "middle", "bottom"];

/** 글자속성 JSON → CSS 선언 문자열. */
function charCss(cp: any): string {
  if (!cp) return "";
  const css: string[] = [];
  if (typeof cp.fontSize === "number") css.push(`font-size:${(cp.fontSize / 100).toFixed(1)}pt`);
  if (cp.bold) css.push("font-weight:700");
  if (cp.italic) css.push("font-style:italic");
  const deco: string[] = [];
  if (cp.underline) deco.push("underline");
  if (cp.strikethrough) deco.push("line-through");
  if (deco.length) css.push(`text-decoration:${deco.join(" ")}`);
  const tc = color(cp.textColor);
  if (tc && tc !== "#000000") css.push(`color:${tc}`);
  if (typeof cp.fontFamily === "string" && cp.fontFamily) css.push(`font-family:'${cp.fontFamily.replace(/'/g, "")}',sans-serif`);
  return css.join(";");
}

/** 한 문단(평문/셀) → 글자·정렬·줄간격 스타일 입힌 <p>. 빈 문단도 글자크기만큼 세로공간 차지. */
function renderPara(text: string, charProps: any, paraProps: any): string {
  const css: string[] = ["margin:0"];
  const align = paraProps?.alignment;
  if (align === "center" || align === "right" || align === "justify") css.push(`text-align:${align}`);
  if (typeof paraProps?.lineSpacing === "number" && paraProps.lineSpacingType === "Percent") {
    css.push(`line-height:${(paraProps.lineSpacing / 100).toFixed(2)}`);
  }
  const cc = charCss(charProps);
  if (cc) css.push(cc);
  // 빈 문단은 <br> 로 한 줄 높이를 확보(HWP 의 빈 문단 = 세로 간격) → 제목페이지 간격 보존.
  return `<p style="${css.join(";")}">${esc(text) || "<br>"}</p>`;
}

/** 표 셀 속성 → td CSS(배경·테두리·세로정렬·너비·패딩). */
function cellCss(props: any): string {
  const css: string[] = [];
  const bg = color(props?.fillColor);
  if (props?.fillType === "solid" && bg && bg !== "#ffffff") css.push(`background:${bg}`);
  const va = props?.verticalAlign;
  if (typeof va === "number" && VALIGN[va]) css.push(`vertical-align:${VALIGN[va]}`);
  // 열 너비는 <colgroup> 으로 지정(td width 는 colspan 과 충돌하므로 안 씀).
  // 테두리: 원본 셀의 변별 type/color 사용(type 0 = 선 없음 → 안 그림, 그 외 = 실선).
  // (width 는 HWP 선두께 enum 이라 px 정밀매핑 대신 1px 근사 — 0.1mm 급이라 화면상 1px.)
  for (const [side, key] of [["left", "borderLeft"], ["right", "borderRight"], ["top", "borderTop"], ["bottom", "borderBottom"]] as const) {
    const b = props?.[key];
    if (b && b.type === 0) { css.push(`border-${side}:0`); continue; }
    css.push(`border-${side}:1px solid ${color(b?.color) ?? "#000000"}`);
  }
  const pl = props?.paddingLeft, pr = props?.paddingRight, pt = props?.paddingTop, pb = props?.paddingBottom;
  if ([pl, pr, pt, pb].every((n) => typeof n === "number")) {
    css.push(`padding:${hu2px(pt)}px ${hu2px(pr)}px ${hu2px(pb)}px ${hu2px(pl)}px`);
  } else css.push("padding:3px 6px");
  return css.join(";");
}

interface TableRef { ci: number; rows: number; cols: number; cells: number }

interface GridCell {
  row: number; col: number; rowSpan: number; colSpan: number; props: any; html: string;
}

/**
 * 표 한 개 → <table> HTML. **getCellInfo 의 실제 row/col/span 으로 그리드를 재구성**(셀을 행우선
 * 순차로 깔면 병합셀 표가 깨진다). 열 너비는 <colgroup>(colSpan==1 셀의 width)로 지정.
 */
function renderRhwpTable(doc: RhwpDoc, s: number, p: number, t: TableRef): string {
  const cells: GridCell[] = [];
  for (let idx = 0; idx < t.cells; idx++) {
    const info = doc.getCellInfo ? pj<any>(safe(() => doc.getCellInfo!(s, p, t.ci, idx))) : null;
    const props = doc.getCellProperties ? pj<any>(safe(() => doc.getCellProperties!(s, p, t.ci, idx))) : null;
    const cpc = safe(() => doc.getCellParagraphCount(s, p, t.ci, idx)) ?? 0;
    let inner = "";
    for (let cp = 0; cp < cpc; cp++) {
      const l = safe(() => doc.getCellParagraphLength(s, p, t.ci, idx, cp)) ?? 0;
      const text = l > 0 ? safe(() => doc.getTextInCell(s, p, t.ci, idx, cp, 0, l)) ?? "" : "";
      const cc = doc.getCellCharPropertiesAt ? pj(safe(() => doc.getCellCharPropertiesAt!(s, p, t.ci, idx, cp, 0))) : null;
      const pcp = doc.getCellParaPropertiesAt ? pj(safe(() => doc.getCellParaPropertiesAt!(s, p, t.ci, idx, cp))) : null;
      inner += renderPara(text, cc, pcp);
    }
    cells.push({
      row: info?.row ?? 0, col: info?.col ?? 0,
      rowSpan: info?.rowSpan > 0 ? info.rowSpan : 1, colSpan: info?.colSpan > 0 ? info.colSpan : 1,
      props, html: inner || "<br>",
    });
  }

  // 열 너비(colSpan==1 셀 기준) → colgroup
  const colW = new Array(Math.max(t.cols, 1)).fill(0);
  for (const c of cells) {
    if (c.colSpan === 1 && c.col < colW.length && typeof c.props?.width === "number") {
      colW[c.col] = Math.max(colW[c.col], hu2px(c.props.width));
    }
  }
  const totalW = colW.reduce((a, b) => a + b, 0);
  const colgroup = totalW > 0 ? `<colgroup>${colW.map((w) => `<col style="width:${w || 40}px">`).join("")}</colgroup>` : "";

  // 시작 행 기준으로 묶고 열순 정렬(rowspan 은 브라우저가 자동 흘림)
  const byRow = new Map<number, GridCell[]>();
  for (const c of cells) {
    if (!byRow.has(c.row)) byRow.set(c.row, []);
    byRow.get(c.row)!.push(c);
  }
  let trs = "";
  for (const r of [...byRow.keys()].sort((a, b) => a - b)) {
    const tds = byRow.get(r)!
      .sort((a, b) => a.col - b.col)
      .map((c) => {
        const span = (c.colSpan > 1 ? ` colspan="${c.colSpan}"` : "") + (c.rowSpan > 1 ? ` rowspan="${c.rowSpan}"` : "");
        return `<td${span} style="${cellCss(c.props)}">${c.html}</td>`;
      })
      .join("");
    trs += `<tr>${tds}</tr>\n`;
  }
  const widthStyle = totalW > 0 ? ` style="width:${totalW}px"` : "";
  return `<table class="hp-tbl"${widthStyle}>${colgroup}<tbody>\n${trs}</tbody></table>`;
}

/**
 * 꼬리말/머리말의 **글자색·크기**는 rhwp 데이터 API 가 노출하지 않으므로 page0 SVG 의 꼬리말
 * 글자(<text>)에서 추출한다(원본 그대로 — 하드코딩 회피). 꼬리말은 페이지 맨 아래라 매칭 글자
 * 중 **y 최대**인 것이 꼬리말. SVG font-size 는 96dpi px → pt = px×0.75.
 */
function footerGlyphStyle(svg: string, footerText: string): { color?: string; pt?: number } {
  const chars = new Set([...footerText.replace(/\s+/g, "")]);
  let bestY = -1;
  let color: string | undefined;
  let pt: number | undefined;
  for (const m of svg.matchAll(/<text\b([^>]*)>([^<]*)<\/text>/g)) {
    if (!chars.has(m[2]!)) continue;
    const a = m[1]!;
    const y = parseFloat(/\by="([\d.]+)"/.exec(a)?.[1] ?? "");
    if (!(y > bestY)) continue;
    bestY = y;
    color = /\bfill="(#[0-9a-fA-F]{6})"/.exec(a)?.[1];
    const fs = parseFloat(/\bfont-size="([\d.]+)"/.exec(a)?.[1] ?? "");
    pt = Number.isFinite(fs) ? Math.round(fs * 0.75 * 10) / 10 : undefined;
  }
  return { color, pt };
}

/**
 * 꼬리말 색·크기를 원본에서 — content 페이지(0번 제목페이지는 본문 회사명과 충돌하므로 제외)의
 * SVG 꼬리말 글자에서 추출. 너무 큰 페이지(이미지)는 건너뛰고 최대 4페이지만 시도(비용 제한).
 */
function footerStyleFromDoc(doc: RhwpDoc, footerText: string): { color?: string; pt?: number } {
  if (!doc.renderPageSvg || !doc.pageCount) return {};
  const n = safe(() => doc.pageCount!()) ?? 0;
  for (let i = 1; i < Math.min(n, 5); i++) {
    const svg = safe(() => doc.renderPageSvg!(i));
    if (!svg || svg.length > 3_000_000) continue;
    const gs = footerGlyphStyle(svg, footerText);
    if (gs.color) return gs;
  }
  return {};
}

/** 표의 모든 셀 텍스트를 공백제거해 이어붙인다(SVG 렌더 누락 판별용 지문). */
function tableTextFingerprint(doc: RhwpDoc, s: number, p: number, t: TableRef): string {
  let txt = "";
  for (let cell = 0; cell < t.cells; cell++) {
    const cpc = safe(() => doc.getCellParagraphCount(s, p, t.ci, cell)) ?? 0;
    for (let cp = 0; cp < cpc; cp++) {
      const l = safe(() => doc.getCellParagraphLength(s, p, t.ci, cell, cp)) ?? 0;
      if (l > 0) txt += safe(() => doc.getTextInCell(s, p, t.ci, cell, cp, 0, l)) ?? "";
    }
  }
  return txt.replace(/\s+/g, "");
}

/** 컨트롤이 이미지면 실제 표시크기(getPictureProperties)로 <img> 반환(아니면 null). */
function renderImage(doc: RhwpDoc, s: number, p: number, ci: number): string | null {
  if (!doc.getControlImageData || !doc.getControlImageMime) return null;
  const mime = safe(() => doc.getControlImageMime!(s, p, ci));
  const data = safe(() => doc.getControlImageData!(s, p, ci));
  if (!mime || !data || !(data as Uint8Array).length) return null;
  const pp = doc.getPictureProperties ? pj<any>(safe(() => doc.getPictureProperties!(s, p, ci))) : null;
  let dim = "";
  if (pp && typeof pp.width === "number" && typeof pp.height === "number" && pp.width > 0) {
    dim = `width:${hu2px(pp.width)}px;height:${hu2px(pp.height)}px;`;
  }
  return `<img alt="" style="${dim}max-width:100%" src="data:${mime};base64,${bytesToBase64(data as Uint8Array)}">`;
}

/**
 * getPageOverlayImages 의 behind/front 항목(쪽배경·도형그림 등 floating)을 절대배치 <img> 로.
 * bbox 는 페이지 좌상단 기준 CSS px. z 는 본문(z-index:1) 대비 뒤(0)/앞(2).
 */
function overlayImg(e: any, z: number): string {
  if (!e || typeof e.mime !== "string" || typeof e.base64 !== "string" || !e.base64) return "";
  const b = e.bbox ?? {};
  const num = (v: any, css: string) => (typeof v === "number" && isFinite(v) ? `${css}:${v}px;` : "");
  const pos = num(b.x, "left") + num(b.y, "top") + num(b.width, "width") + num(b.height, "height");
  return `<img class="hp-overlay" alt="" style="${pos}z-index:${z}" src="data:${e.mime};base64,${e.base64}">`;
}

/**
 * getPageControlLayout 의 그림 컨트롤(type:"image", x/y/w/h px)을 절대배치 <img> 로.
 * 바이트는 BinData 풀에서 받은 data URI(uri). 글 앞 레이어(z-index:2)에 둔다.
 */
function layoutImg(im: any, uri: string): string {
  if (!uri) return "";
  const num = (v: any, css: string) => (typeof v === "number" && isFinite(v) ? `${css}:${v}px;` : "");
  const pos = num(im.x, "left") + num(im.y, "top") + num(im.w, "width") + num(im.h, "height");
  return `<img class="hp-overlay" alt="" style="${pos}z-index:2" src="${uri}">`;
}

/**
 * rhwp 문서 → 리치 미리보기 HTML(선택·드래그·편집 가능한 진짜 HTML).
 * 평문문단·표(병합셀 그리드+셀 배경/정렬/글자)·이미지(실제크기)를 렌더하고, **rhwp 의 실제
 * 페이지번호(getPageOfPosition)로 종이 페이지를 나눠** 쌓는다. 절대좌표 픽셀일치는 아니지만
 * 표 구조·이미지 크기·페이지 구분이 맞고, 텍스트를 드래그/선택/편집할 수 있다.
 */
export function hwpToRichPreviewHtml(
  doc: RhwpDoc,
  opts: { title?: string; rawBytes?: Uint8Array } = {},
): string {
  const secN = sectionCount(doc);
  const pageDef = doc.getPageDef ? pj<any>(safe(() => doc.getPageDef!(0))) : null;
  const pageW = pageDef && pageDef.width ? hu2px(pageDef.width) : 794;
  const pad = pageDef
    ? `${hu2px(pageDef.marginTop ?? 0)}px ${hu2px(pageDef.marginRight ?? 0)}px ${hu2px(pageDef.marginBottom ?? 0)}px ${hu2px(pageDef.marginLeft ?? 0)}px`
    : "40px 44px";

  // 꼬리말 텍스트(섹션0, 양쪽) — 각 페이지 하단에 렌더(흐름배치라 페이지 끝에 붙는다).
  // 정렬·색·크기 전부 원본에서: 정렬=getParaPropertiesInHf, 색/크기=page0 SVG 꼬리말 글자(데이터 API 부재).
  const footer = doc.getHeaderFooter ? pj<any>(safe(() => doc.getHeaderFooter!(0, false, 0))) : null;
  const footerText = footer?.exists && typeof footer.text === "string" ? footer.text.trim() : "";
  let footStyle = "";
  if (footerText) {
    const fp = doc.getParaPropertiesInHf ? pj<any>(safe(() => doc.getParaPropertiesInHf!(0, false, 0, 0))) : null;
    const align = fp?.alignment;
    const gs = footerStyleFromDoc(doc, footerText);
    footStyle = [
      align === "left" || align === "center" || align === "right" ? `text-align:${align}` : "",
      gs.color ? `color:${gs.color}` : "",
      gs.pt ? `font-size:${gs.pt}pt` : "",
    ].filter(Boolean).join(";");
  }

  // 페이지번호별 본문 누적(rhwp 가 계산한 실제 페이지 분할 사용).
  const pageBodies = new Map<number, string>();
  const add = (pg: number, html: string) => pageBodies.set(pg, (pageBodies.get(pg) ?? "") + html);
  // 인라인으로 이미 렌더한 그림의 data URI(= 같은 BinData 바이트) — floating 보강 시 중복 제거용.
  const renderedImgUris = new Set<string>();

  for (let s = 0; s < secN; s++) {
    const pc = safe(() => doc.getParagraphCount(s)) ?? 0;
    for (let p = 0; p < pc; p++) {
      const pgInfo = doc.getPageOfPosition ? pj<any>(safe(() => doc.getPageOfPosition!(s, p))) : null;
      const pg = typeof pgInfo?.page === "number" ? pgInfo.page : 0;
      const ctrls = pj<number[]>(safe(() => doc.getControlTextPositions(s, p))) ?? [];
      const tables = tablesInPara(doc, s, p);
      const tableCis = new Set(tables.map((t) => t.ci));

      for (let ci = 0; ci < ctrls.length; ci++) {
        if (tableCis.has(ci)) continue;
        const img = renderImage(doc, s, p, ci);
        if (img) {
          const m = img.match(/src="([^"]+)"/);
          if (m) renderedImgUris.add(m[1]!);
          add(pg, `<div class="hp-img">${img}</div>\n`);
        }
      }

      // 평문 문단(빈 문단도 렌더 → 세로 간격 보존. 컨트롤 문단은 제외).
      if (ctrls.length === 0) {
        const plen = safe(() => doc.getParagraphLength(s, p)) ?? 0;
        const text = plen > 0 ? safe(() => doc.getTextRange(s, p, 0, plen)) ?? "" : "";
        const cprops = doc.getCharPropertiesAt ? pj(safe(() => doc.getCharPropertiesAt!(s, p, 0))) : null;
        const pprops = doc.getParaPropertiesAt ? pj(safe(() => doc.getParaPropertiesAt!(s, p))) : null;
        add(pg, renderPara(text, cprops, pprops) + "\n");
      }

      for (const t of tables) add(pg, renderRhwpTable(doc, s, p, t) + "\n");
    }
  }

  // ── floating 그림(쪽배경·도형 등) → 해당 페이지 본문 흐름에 "표시크기"로 인라인 배치 ──────
  // 흐름배치 미리보기라 절대좌표는 쓰지 않는다(절대배치는 본문과 어긋나 떠 보이고 빈 페이지를
  // 만든다). 크기 출처: (a) getPageOverlayImages 의 behind/front 항목 bbox, (b) 항목이 비면
  // getPageControlLayout 의 image(w/h). 바이트: (a)는 항목 base64, (b)는 BinData 풀(문서순).
  // (인라인으로 이미 그린 그림은 같은 data URI 로 제외해 중복을 막는다.)
  if (doc.getPageOverlayImages) {
    const pool = opts.rawBytes
      ? extractHwpBinImages(opts.rawBytes).filter((u) => !renderedImgUris.has(u))
      : [];
    let pi = 0;
    const dim = (w?: number, h?: number) =>
      (typeof w === "number" && w > 0 ? `width:${Math.round(w)}px;` : "") +
      (typeof h === "number" && h > 0 ? `height:${Math.round(h)}px;` : "");
    const flowImg = (pg: number, uri: string, w?: number, h?: number) =>
      uri && add(pg, `<div class="hp-img"><img alt="" style="${dim(w, h)}max-width:100%" src="${uri}"></div>\n`);
    // 페이지 번호는 getPageOfPosition 과 동일한 0-based. 존재하지 않는 페이지는 오류 → null → 종료.
    for (let pg = 0; pg <= 5000; pg++) {
      const ov = pj<any>(safe(() => doc.getPageOverlayImages!(pg)));
      if (ov == null) break;
      const entries = [
        ...(Array.isArray(ov.behind) ? ov.behind : []),
        ...(Array.isArray(ov.front) ? ov.front : []),
      ];
      if (entries.length) {
        for (const e of entries) {
          if (e?.mime && e?.base64) flowImg(pg, `data:${e.mime};base64,${e.base64}`, e.bbox?.width, e.bbox?.height);
        }
        continue;
      }
      const count = typeof ov.imageCount === "number" ? ov.imageCount : 0;
      if (count <= 0 || pool[pi] === undefined) continue;
      // 크기: getPageControlLayout 의 그림 컨트롤(문서순) w/h. 바이트: BinData 풀에서 순서대로.
      const layout = doc.getPageControlLayout ? pj<any>(safe(() => doc.getPageControlLayout!(pg))) : null;
      const imgs = (Array.isArray(layout?.controls) ? layout.controls : []).filter((c: any) => c?.type === "image");
      for (let k = 0; k < count && pool[pi] !== undefined; k++) {
        flowImg(pg, pool[pi++]!, imgs[k]?.w, imgs[k]?.h);
      }
    }
  }

  const pages = [...pageBodies.keys()].sort((a, b) => a - b);
  const foot = footerText ? `<div class="hp-footer" style="${footStyle}">${esc(footerText)}</div>` : "";
  const pagesHtml = pages.length
    ? pages.map((pg) => `<div class="hp-page">${pageBodies.get(pg) ?? ""}${foot}</div>`).join("\n")
    : `<div class="hp-page">${foot}</div>`;
  const title = esc(opts.title ?? "한글 미리보기");
  return `<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><title>${title}</title>
<style>
  body{margin:0;background:#eceef0;padding:24px 0;font-family:'맑은 고딕','Malgun Gothic','Apple SD Gothic Neo',sans-serif;color:#111}
  .hp-page{width:${pageW}px;max-width:96%;margin:0 auto 22px;background:#fff;padding:${pad};
    box-shadow:0 1px 4px rgba(0,0,0,.12),0 8px 24px rgba(0,0,0,.10);line-height:1.5;font-size:10.5pt;box-sizing:border-box}
  .hp-tbl{border-collapse:collapse;table-layout:fixed;margin:8px 0;max-width:100%}
  /* 테두리/정렬/색은 셀별 인라인(cellCss)로 원본 데이터 지정 — 여기선 안 박는다 */
  .hp-tbl td{vertical-align:middle;padding:2px 5px;word-break:break-word;overflow-wrap:anywhere}
  .hp-tbl p{margin:0}
  .hp-img{margin:6px 0}
  .hp-img img{display:block}
  /* 꼬리말 정렬·색·크기는 인라인(원본)로 지정. 원본엔 구분선 없으므로 여백만(페이지 하단 공백). */
  .hp-footer{margin-top:24px}
</style></head><body>${pagesHtml}</body></html>`;
}

/** SVG 의 모든 <text> 글자를 읽기순서로 이어붙인 "글자 수프"(공백제거). 렌더 누락 판별용. */
function svgGlyphSoup(svgs: string[]): string {
  let soup = "";
  for (const svg of svgs) {
    for (const m of svg.matchAll(/<text\b[^>]*>([^<]*)<\/text>/g)) {
      soup += m[1]!
        .replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    }
  }
  return soup.replace(/\s+/g, "");
}

/** 표의 가장 긴 셀 텍스트(렌더 판별용 지문 — 길수록 오탐 적음). */
function longestCellText(doc: RhwpDoc, s: number, p: number, t: TableRef): string {
  let best = "";
  for (let cell = 0; cell < t.cells; cell++) {
    const cpc = safe(() => doc.getCellParagraphCount(s, p, t.ci, cell)) ?? 0;
    for (let cp = 0; cp < cpc; cp++) {
      const l = safe(() => doc.getCellParagraphLength(s, p, t.ci, cell, cp)) ?? 0;
      if (l <= 0) continue;
      const txt = (safe(() => doc.getTextInCell(s, p, t.ci, cell, cp, 0, l)) ?? "").replace(/\s+/g, "");
      if (txt.length > best.length) best = txt;
    }
  }
  return best;
}

/**
 * 하이브리드 미리보기: rhwp 의 **SVG 렌더(충실)** 를 주로 쓰되, SVG 가 **렌더 누락한 표만**
 * HTML 로 보충 추가한다. 일반 문서는 순수 SVG(픽셀 충실), 일부 표를 놓치는 문서(예: 마지막
 * 1칸 표)는 SVG + 누락분 표 HTML → 충실도와 완전성을 동시에 얻는다.
 *
 * 누락 판별: SVG 는 글자마다 개별 <text> 라 substring 검색이 안 된다. 모든 <text> 를 읽기순서로
 * 이은 "글자 수프"에 표의 대표 셀텍스트가 연속으로 들어있으면 렌더된 것, 없으면 누락.
 */
export function hwpToHybridPreviewHtml(doc: RhwpDoc, opts: { title?: string } = {}): string {
  const n = doc.pageCount ? safe(() => doc.pageCount!()) ?? 0 : 0;
  const svgs: string[] = [];
  if (doc.renderPageSvg) {
    for (let i = 0; i < n; i++) {
      const svg = safe(() => doc.renderPageSvg!(i));
      if (svg) svgs.push(svg);
    }
  }
  // SVG 가 없으면(렌더 불가) 흐름배치 리치 미리보기로 폴백.
  if (svgs.length === 0) return hwpToRichPreviewHtml(doc, opts);

  const soup = svgGlyphSoup(svgs);
  const secN = sectionCount(doc);
  const dropped: string[] = [];
  for (let s = 0; s < secN; s++) {
    const pc = safe(() => doc.getParagraphCount(s)) ?? 0;
    for (let p = 0; p < pc; p++) {
      for (const t of tablesInPara(doc, s, p)) {
        const probe = longestCellText(doc, s, p, t);
        if (probe.length >= 4 && !soup.includes(probe)) dropped.push(renderRhwpTable(doc, s, p, t));
      }
    }
  }

  const pagesHtml = svgs.map((svg) => `<div class="rhwp-page">${svg}</div>`).join("\n");
  const supplement = dropped.length
    ? `<div class="hp-supp"><div class="hp-supp-note">⚠ 미리보기 렌더러가 놓친 표 ${dropped.length}개 — 내용 보존용</div>${dropped.join("\n")}</div>`
    : "";
  const title = esc(opts.title ?? "한글 미리보기");
  return `<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><title>${title}</title>
<style>
  body{margin:0;background:#eceef0;padding:24px 0;font-family:'맑은 고딕','Malgun Gothic','Apple SD Gothic Neo',sans-serif;color:#111}
  .rhwp-page{margin:0 auto 22px;background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.12),0 8px 24px rgba(0,0,0,.10);width:fit-content;max-width:97%}
  .rhwp-page svg{display:block;max-width:100%;height:auto}
  .hp-supp{max-width:840px;margin:8px auto 22px;background:#fff;padding:18px 22px;border:1px solid #e3e7f0;border-radius:8px}
  .hp-supp-note{font-size:12px;color:#b45309;background:#fffbeb;border:1px solid #fde68a;border-radius:6px;padding:6px 10px;margin-bottom:12px}
  .hp-tbl{border-collapse:collapse;width:100%;margin:10px 0}
  .hp-tbl td{border:1px solid #bbb;vertical-align:middle;padding:3px 6px}
  .hp-tbl p{margin:0}
</style></head><body>${pagesHtml}${supplement}</body></html>`;
}

/**
 * renderPageHtml 한 페이지에서 "콘텐츠가 페이지 높이 밖으로 얼마나 밀렸는지"(px)를 잰다.
 * rhwp 는 '글 뒤(behind)' floating 배경(예: 상장 테두리)을 흐름 공간으로 잘못 계산해 본문을
 * 프레임 높이만큼 아래로 밀어버리는 버그가 있다 → 페이지 높이 고정+overflow:hidden 에 잘려
 * 텍스트가 통째로 사라진다. 이 값이 크면 그 버그에 걸린 페이지다.
 */
function pageContentOverflow(pageHtml: string): number {
  const pageH = Number(pageHtml.match(/class="hwp-page"[^>]*?height:([\d.]+)px/)?.[1] ?? 0);
  if (!pageH) return 0;
  let maxBottom = 0;
  for (const m of pageHtml.matchAll(/top:([\d.]+)px;[^"]*?height:([\d.]+)px/g)) {
    maxBottom = Math.max(maxBottom, Number(m[1]) + Number(m[2]));
  }
  for (const m of pageHtml.matchAll(/top:([\d.]+)px/g)) {
    maxBottom = Math.max(maxBottom, Number(m[1]));
  }
  return maxBottom - pageH;
}

/**
 * rhwp 의 HTML 페이지 렌더(renderPageHtml)를 페이지별로 이어붙인 **충실 미리보기**.
 * rhwp 가 직접 그리므로 이미지(쪽배경·floating 그림)의 위치·크기·z순서, 표·머릿말/꼬리말이
 * 모두 원본 그대로다. 각 페이지는 절대배치 자립형 HTML(고정 px 크기)이라 외부 CSS 가 필요 없고,
 * 텍스트는 실제 텍스트라 선택·복사된다.
 *
 * 단, rhwp 가 '글 뒤' floating 배경을 흐름으로 잘못 계산해 본문을 페이지 밖으로 크게 밀어내는
 * 문서(예: 테두리 배경 상장)에서는 텍스트가 잘려 사라진다. 그런 페이지가 감지되면(또는
 * renderPageHtml 미지원/실패 시) 흐름배치 `hwpToRichPreviewHtml` 로 폴백한다 — 절대좌표는 못
 * 맞춰도 텍스트·배경이 모두 보인다.
 */
export function hwpToFaithfulPreviewHtml(
  doc: RhwpDoc,
  opts: { title?: string; rawBytes?: Uint8Array } = {},
): string {
  const n = doc.pageCount && doc.renderPageHtml ? safe(() => doc.pageCount!()) ?? 0 : 0;
  const rendered: string[] = [];
  let worstOverflow = 0;
  for (let i = 0; i < n; i++) {
    const h = safe(() => doc.renderPageHtml!(i));
    if (!h) continue;
    rendered.push(h);
    worstOverflow = Math.max(worstOverflow, pageContentOverflow(h));
  }
  // renderPageHtml 미지원/실패, 또는 rhwp 레이아웃 버그로 본문이 페이지 밖으로 크게 밀린 경우
  // (텍스트 잘림) → 흐름배치 미리보기로 폴백. 임계값 200px(약 페이지 높이의 18%).
  if (rendered.length === 0 || worstOverflow > 200) return hwpToRichPreviewHtml(doc, opts);

  const pages = rendered.map((h) => `<div class="hp-paper">${h}</div>`);
  const title = esc(opts.title ?? "한글 미리보기");
  return `<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><title>${title}</title>
<style>
  body{margin:0;background:#eceef0;padding:24px 0;font-family:'맑은 고딕','Malgun Gothic','Apple SD Gothic Neo',sans-serif;color:#111}
  /* rhwp 페이지는 고정 px 크기의 절대배치 HTML. 그대로 종이처럼 가운데 정렬+그림자. */
  .hp-paper{margin:0 auto 22px;width:fit-content;max-width:100%;background:#fff;
    box-shadow:0 1px 4px rgba(0,0,0,.12),0 8px 24px rgba(0,0,0,.10)}
  .hp-paper .hwp-page{max-width:100%}
  .hp-paper img{max-width:none}
</style></head><body>${pages.join("\n")}</body></html>`;
}
