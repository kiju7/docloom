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
  getHeaderFooterParaInfo?(section: number, isHeader: boolean, applyTo: number, hfParaIdx: number): string;
  insertTextInHeaderFooter?(section: number, isHeader: boolean, applyTo: number, hfParaIdx: number, charOffset: number, text: string): string;
  deleteTextInHeaderFooter?(section: number, isHeader: boolean, applyTo: number, hfParaIdx: number, charOffset: number, count: number): string;
  // 하이브리드 미리보기(hwpToHybridPreviewHtml)용 — rhwp 의 SVG 렌더.
  pageCount?(): number;
  renderPageSvg?(page: number): string;
  // 충실 미리보기(hwpToFaithfulPreviewHtml)용 — rhwp 의 HTML 렌더(이미지·표·텍스트 절대배치, 자립형).
  renderPageHtml?(page: number): string;
  // ── 트리 미리보기(hwpToTreePreviewHtml)용 — 구조/스타일/색 데이터 ──
  /** 페이지 렌더 트리(계층): Page>Body>Column>Table>Cell>(Table|Image|TextLine>TextRun). */
  getPageRenderTree?(page: number): string;
  /** 페이지 텍스트 런: {runs:[{text,x,y,w,h,fontFamily,fontSize,bold,italic,underline,textColor,
   *  paraShapeId,secIdx,paraIdx,parentParaIdx,controlIdx,cellIdx,cellPath:[{controlIndex,cellIndex,cellParaIndex}]}]}. */
  getPageTextLayout?(page: number): string;
  /** 페이지 레이어 트리(페인트 ops: {type,bbox,backgroundColor,borderWidth,...}) — 셀 배경/테두리색용. */
  getPageLayerTree?(page: number): string;
  // ── 중첩표(표 안의 표)용 ByPath — pathJson = [{controlIndex,cellIndex,cellParaIndex}, ...] ──
  getTableDimensionsByPath?(section: number, parentPara: number, pathJson: string): string;
  getCellInfoByPath?(section: number, parentPara: number, pathJson: string): string;
  getCellParagraphCountByPath?(section: number, parentPara: number, pathJson: string): number;
  getCellParagraphLengthByPath?(section: number, parentPara: number, pathJson: string): number;
  getTextInCellByPath?(
    section: number, parentPara: number, pathJson: string, charOffset: number, count: number,
  ): string;
  getTableCellBboxesByPath?(section: number, parentPara: number, pathJson: string): string;
  // 중첩표 셀 쓰기(편집-복원) — round-trip 의 핵심.
  insertTextInCellByPath?(
    section: number, parentPara: number, pathJson: string, charOffset: number, text: string,
  ): string;
  deleteTextInCellByPath?(
    section: number, parentPara: number, pathJson: string, charOffset: number, count: number,
  ): string;
}

/** 중첩표 경로 스텝 → rhwp pathJson. steps = [[controlIndex,cellIndex,cellParaIndex], ...] */
function cellPathJson(steps: Array<[number, number, number]>): string {
  return "[" + steps.map(([c, e, p]) => `{"controlIndex":${c},"cellIndex":${e},"cellParaIndex":${p}}`).join(",") + "]";
}

/**
 * 한 셀 문단(경로 path 로 지정)이 품은 **중첩표**들을 찾는다. rhwp 엔 "셀 안 컨트롤 열거" API 가
 * 없어 controlIndex 를 0..MAX 로 탐침: 그 자리 컨트롤이 표면 getTableDimensionsByPath 가 셀 수>0 을
 * 돌려준다(표가 아니면 null). 연속 실패가 길어도 뒤에 표가 있을 수 있어 고정 상한까지 훑는다.
 */
function nestedTablesAt(
  doc: RhwpDoc, s: number, parentPara: number, path: Array<[number, number, number]>,
): Array<{ ci: number; rows: number; cols: number; cells: number }> {
  if (!doc.getTableDimensionsByPath) return [];
  const out: Array<{ ci: number; rows: number; cols: number; cells: number }> = [];
  const MAX_CTRL = 16;
  for (let ci = 0; ci < MAX_CTRL; ci++) {
    const pj0 = cellPathJson([...path, [ci, 0, 0]]);
    const dim = pj<{ rowCount: number; colCount: number; cellCount: number }>(
      safe(() => doc.getTableDimensionsByPath!(s, parentPara, pj0)),
    );
    if (dim && dim.cellCount > 0) out.push({ ci, rows: dim.rowCount, cols: dim.colCount, cells: dim.cellCount });
  }
  return out;
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

/** 중첩 셀 경로 앵커 인코딩: data-hcp="s|parentPara|ci.cell.cp_ci2.cell2.cp2..." (속성 안전). */
function encodeHcp(s: number, parentPara: number, steps: Array<[number, number, number]>): string {
  return `${s}|${parentPara}|${steps.map((st) => st.join(".")).join("_")}`;
}
/** data-hcp 디코드 → {s, parentPara, steps, pathJson}. 실패 시 null. */
function decodeHcp(v: string): { s: number; parentPara: number; pathJson: string } | null {
  const [a, b, stepsStr] = v.split("|");
  if (a == null || b == null || !stepsStr) return null;
  const s = Number(a), parentPara = Number(b);
  const steps = stepsStr.split("_").map((st) => st.split(".").map(Number) as [number, number, number]);
  if (!Number.isInteger(s) || !Number.isInteger(parentPara) || steps.some((st) => st.length !== 3 || st.some((n) => !Number.isInteger(n)))) return null;
  return { s, parentPara, pathJson: cellPathJson(steps) };
}

/**
 * 한 셀 문단(basePath) 안의 **중첩표**들을 편집 가능한 `<table data-htp>` 로 재귀 렌더한다.
 * 각 중첩 셀 문단은 `<div data-hcp="...">` 로 경로 앵커를 달아 LLM 이 읽고 고칠 수 있게 하고,
 * applyHwpEdits 가 insert/deleteTextInCellByPath 로 원본에 되돌린다. 더 깊은 중첩도 재귀로 처리.
 */
function renderNestedTablesEditable(
  doc: RhwpDoc, s: number, parentPara: number, basePath: Array<[number, number, number]>,
): string {
  if (!doc.getTextInCellByPath || !doc.getCellParagraphCountByPath || !doc.getCellParagraphLengthByPath) return "";
  let html = "";
  for (const nt of nestedTablesAt(doc, s, parentPara, basePath)) {
    html += `<table class="hwp-tbl hwp-nested" data-htp="${encodeHcp(s, parentPara, [...basePath, [nt.ci, 0, 0]])}">\n<tbody>\n`;
    let cell = 0;
    for (let r = 0; r < nt.rows && cell < nt.cells; r++) {
      html += "<tr>";
      for (let c = 0; c < nt.cols && cell < nt.cells; c++) {
        const cpc = safe(() => doc.getCellParagraphCountByPath!(s, parentPara, cellPathJson([...basePath, [nt.ci, cell, 0]]))) ?? 0;
        let inner = "";
        for (let cp = 0; cp < cpc; cp++) {
          const path: Array<[number, number, number]> = [...basePath, [nt.ci, cell, cp]];
          const pjp = cellPathJson(path);
          const l = safe(() => doc.getCellParagraphLengthByPath!(s, parentPara, pjp)) ?? 0;
          const text = l > 0 ? safe(() => doc.getTextInCellByPath!(s, parentPara, pjp, 0, l)) ?? "" : "";
          inner += `<div data-hcp="${encodeHcp(s, parentPara, path)}">${esc(text) || "<br>"}</div>`;
          inner += renderNestedTablesEditable(doc, s, parentPara, path); // 더 깊은 중첩
        }
        html += `<td>${inner || "<br>"}</td>`;
        cell++;
      }
      html += "</tr>\n";
    }
    html += "</tbody>\n</table>\n";
  }
  return html;
}

/**
 * rhwp 문서 → 편집용 HTML.
 * 편집 가능한 텍스트마다 앵커를 단다: 평문 문단 `data-h="s,p"`, 표 셀 문단
 * `data-hc="s,p,control,cell,cellPara"`, **중첩표 셀 `data-hcp="s|parentPara|경로"`**.
 */
/** 문단의 (0-based) 페이지 번호. getPageOfPosition 미지원/실패 시 null. */
function pageOf(doc: RhwpDoc, s: number, p: number): number | null {
  const r = doc.getPageOfPosition ? pj<any>(safe(() => doc.getPageOfPosition!(s, p))) : null;
  return r && typeof r.page === "number" ? r.page : null;
}

/** 편집화면용 페이지 구분선(시각 전용·편집불가·앵커없음 → 복원에 영향 없음). */
function pageBreakMarker(pageNum: number): string {
  return `<div class="hwp-pagebreak" contenteditable="false" data-norestore="1">⎯ ${pageNum + 1} 쪽 ⎯</div>\n`;
}

/**
 * 표 셀의 첫 줄 **시각 정렬**(left/right/center)을 `pi|ci|row|col` 로 색인.
 * 편집 표가 트리 미리보기(lineAlign, bbox 기반)와 같은 정렬을 쓰게 한다 — hwpx 는
 * getCellParaProperties.alignment 가 실제 표시(왼쪽)와 어긋나 "center" 라고 하는 셀이 있어,
 * 논리값만 믿으면 표 정렬이 뒤죽박죽이 된다. 중첩표(pi/ci 없음)는 제외.
 */
function buildCellAlignMap(doc: RhwpDoc): Map<string, string> {
  const m = new Map<string, string>();
  if (!doc.getPageRenderTree || !doc.pageCount) return m;
  const n = safe(() => doc.pageCount!()) ?? 0;
  const firstTextLine = (node: TNode): TNode | null => {
    if (!node || typeof node !== "object") return null;
    if (node.type === "TextLine" &&
      (node.children ?? []).some((c) => c.type === "TextRun" && (c.text ?? "").length)) return node;
    if (node.type === "Table") return null; // 이 셀 자체 줄만(중첩표로 안 내려감)
    for (const c of node.children ?? []) { const r = firstTextLine(c); if (r) return r; }
    return null;
  };
  const walk = (node: TNode): void => {
    if (!node || typeof node !== "object") return;
    if (node.type === "Table" && typeof node.pi === "number" && typeof node.ci === "number") {
      for (const cell of (node.children ?? []).filter((c) => c.type === "Cell")) {
        const fl = firstTextLine(cell);
        if (!fl) continue;
        const key = `${node.pi}|${node.ci}|${cell.row ?? 0}|${cell.col ?? 0}`;
        if (!m.has(key)) m.set(key, lineAlign(fl) || "left");
      }
    }
    for (const c of node.children ?? []) walk(c);
  };
  for (let pg = 0; pg < n; pg++) {
    const tree = pj<TNode>(safe(() => doc.getPageRenderTree!(pg)));
    if (tree) walk(tree);
  }
  return m;
}

interface HfBlock { s: number; isHeader: boolean; applyTo: number; parts: string[] }

/**
 * 한 섹션의 머리말/꼬리말 수집. getHeaderFooter 의 `text`(문단을 \n 으로 이은 것)를 문단별로 분리한다.
 * applyTo(0=양쪽/1=짝수/2=홀수)를 훑되 같은 물리 HF(paraIndex/controlIndex)는 중복 제거.
 * 내용이 전부 공백인 HF(빈 머리말 등)는 화면을 어지럽히지 않게 제외.
 */
function collectHfBlocks(doc: RhwpDoc, s: number): HfBlock[] {
  if (!doc.getHeaderFooter) return [];
  const out: HfBlock[] = [];
  const seen = new Set<string>();
  for (const isHeader of [true, false]) {
    for (const at of [0, 1, 2]) {
      const hf = pj<any>(safe(() => doc.getHeaderFooter!(s, isHeader, at)));
      if (!hf || !hf.exists) continue;
      const key = `${isHeader}|${hf.paraIndex ?? -1}|${hf.controlIndex ?? -1}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const applyTo = typeof hf.applyTo === "number" ? hf.applyTo : at;
      const parts = (typeof hf.text === "string" ? hf.text : "").split("\n");
      if (parts.every((p: string) => norm(p) === "")) continue; // 빈 HF 제외
      out.push({ s, isHeader, applyTo, parts });
    }
  }
  return out;
}

/** 머리말/꼬리말 한 개 → 라벨 + 문단별 편집 가능 div(앵커 data-hf="s,isHeader,applyTo,paraIdx"). */
function renderHfEditable(b: HfBlock): string {
  const kind = b.isHeader ? "머리말" : "꼬리말";
  const tag = b.applyTo === 1 ? " (짝수 쪽)" : b.applyTo === 2 ? " (홀수 쪽)" : "";
  const ish = b.isHeader ? 1 : 0;
  let inner = "";
  for (let i = 0; i < b.parts.length; i++) {
    inner += `<div data-hf="${b.s},${ish},${b.applyTo},${i}" style="white-space:pre-wrap">${esc(b.parts[i]!) || "<br>"}</div>`;
  }
  return `<div class="hwp-hf" data-hf-kind="${b.isHeader ? "header" : "footer"}">` +
    `<span class="hwp-hf-label" contenteditable="false">${kind}${tag}</span>${inner}</div>\n`;
}

export function hwpToEditableHtml(doc: RhwpDoc): string {
  const secN = sectionCount(doc);
  // 머리말/꼬리말(편집 가능) — 머리말은 본문 위, 꼬리말은 본문 아래에 배치한다.
  const headers: string[] = [];
  const footers: string[] = [];
  for (let s = 0; s < secN; s++) {
    for (const b of collectHfBlocks(doc, s)) (b.isHeader ? headers : footers).push(renderHfEditable(b));
  }
  // 셀 정렬은 트리(시각) 기준 — hwpx 논리 alignment 가 어긋나는 셀 보정.
  const alignMap = buildCellAlignMap(doc);
  let body = "";
  let lastPage = -1; // 직전 문단의 페이지(0-based). 증가하면 구분선을 넣어 페이지 경계를 보여준다.
  for (let s = 0; s < secN; s++) {
    const pc = safe(() => doc.getParagraphCount(s)) ?? 0;
    for (let p = 0; p < pc; p++) {
      const tables = tablesInPara(doc, s, p);
      const ctrlCount = (pj<number[]>(safe(() => doc.getControlTextPositions(s, p))) ?? []).length;

      // 페이지 경계: 이 문단이 새 페이지에서 시작하면 구분선 삽입(미리보기의 종이 구분 ≈ 흐름 편집기).
      const pg = pageOf(doc, s, p);
      if (pg !== null && lastPage !== -1 && pg > lastPage) body += pageBreakMarker(pg);
      if (pg !== null) lastPage = pg;

      // 평문 문단(컨트롤 없음): 미리보기와 같은 글자·정렬 스타일을 입힌 편집 가능한 <p>.
      // (빈 문단도 앵커를 달아 편집 시 채울 수 있게 한다.)
      if (ctrlCount === 0) {
        const plen = safe(() => doc.getParagraphLength(s, p)) ?? 0;
        const text = plen > 0 ? safe(() => doc.getTextRange(s, p, 0, plen)) ?? "" : "";
        const cprops = doc.getCharPropertiesAt ? pj(safe(() => doc.getCharPropertiesAt!(s, p, 0))) : null;
        const pprops = doc.getParaPropertiesAt ? pj(safe(() => doc.getParaPropertiesAt!(s, p))) : null;
        body += editablePara(text, cprops, pprops, `data-h="${s},${p}"`) + "\n";
      }

      // 표: 미리보기와 동일한 병합·열너비·셀배경·정렬을 입히되, 셀 문단마다 data-hc 앵커로 복원 가능.
      for (const t of tables) {
        body += renderRhwpTable(doc, s, p, t, { editable: true, alignMap }) + "\n";
      }
    }
  }
  return `<div class="hwp-edit" data-hwp-edit="1">\n${headers.join("")}${body}${footers.join("")}</div>`;
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

  // 중첩표(표 안의 표) 셀 문단 — 경로(data-hcp) 기반 insert/deleteTextInCellByPath 로 되돌림.
  if (doc.getTextInCellByPath && doc.getCellParagraphLengthByPath && doc.insertTextInCellByPath && doc.deleteTextInCellByPath) {
    for (const el of root.querySelectorAll("[data-hcp]")) {
      const dec = decodeHcp(el.getAttribute("data-hcp") ?? "");
      if (!dec) continue;
      const { s, parentPara, pathJson } = dec;
      const next = nodeText(el);
      const len = safe(() => doc.getCellParagraphLengthByPath!(s, parentPara, pathJson)) ?? 0;
      const cur = norm(len > 0 ? safe(() => doc.getTextInCellByPath!(s, parentPara, pathJson, 0, len)) ?? "" : "");
      if (cur === next) continue;
      if (len > 0) safe(() => doc.deleteTextInCellByPath!(s, parentPara, pathJson, 0, len));
      if (next) safe(() => doc.insertTextInCellByPath!(s, parentPara, pathJson, 0, next));
      changed++;
    }
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

  // 머리말/꼬리말 — data-hf="s,isHeader(1/0),applyTo,hfParaIdx". 문단별 텍스트 교체.
  if (doc.getHeaderFooter && doc.insertTextInHeaderFooter && doc.deleteTextInHeaderFooter) {
    for (const el of root.querySelectorAll("[data-hf]")) {
      const a = addr(el, "data-hf");
      if (!a || a.length !== 4) continue;
      const [s, ish, at, pi] = a;
      const isHeader = ish === 1;
      const next = nodeText(el);
      const hf = pj<any>(safe(() => doc.getHeaderFooter!(s!, isHeader, at!)));
      if (!hf || !hf.exists) continue;
      const parts = (typeof hf.text === "string" ? hf.text : "").split("\n");
      const cur = norm(parts[pi!] ?? "");
      if (cur === next) continue;
      const info = pj<any>(safe(() => doc.getHeaderFooterParaInfo?.(s!, isHeader, at!, pi!)));
      const len = info && typeof info.charCount === "number" ? info.charCount : [...(parts[pi!] ?? "")].length;
      if (len > 0) safe(() => doc.deleteTextInHeaderFooter!(s!, isHeader, at!, pi!, 0, len));
      if (next) safe(() => doc.insertTextInHeaderFooter!(s!, isHeader, at!, pi!, 0, next));
      changed++;
    }
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
  if (typeof cp.fontFamily === "string" && cp.fontFamily) css.push(`font-family:${fontStack(cp.fontFamily)}`);
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
  // 문단 내 줄바꿈(\n, shift+enter)은 <br> 로 보존. 빈 문단은 <br> 로 한 줄 높이 확보(HWP 빈문단=세로간격).
  const inner = text ? esc(text).replace(/\n/g, "<br>") : "<br>";
  return `<p style="${css.join(";")}">${inner}</p>`;
}

/**
 * 편집용 문단/셀 스타일(정렬·줄간격·글자속성 + 공백/탭/줄바꿈 보존).
 * ⚠ 편집 텍스트는 **literal newline 그대로**(white-space:pre-wrap 로 시각만 줄바꿈) — `\n→<br>` 로
 * 바꾸면 applyHwpEdits 의 nodeText(=textContent)가 줄바꿈을 잃어 왕복이 깨진다. 그래서 renderPara
 * 와 달리 텍스트 표현은 손대지 않고 스타일만 입힌다(앵커 텍스트 동등성 유지 → 복원 안전).
 */
function paraEditCss(charProps: any, paraProps: any, alignOverride?: string): string {
  const css: string[] = ["margin:0", "white-space:pre-wrap"];
  // 정렬: 호출자가 시각 정렬(트리 lineAlign)을 주면 그걸 신뢰한다. hwpx 는 getCellParaProperties
  // 의 alignment 가 실제 표시(왼쪽)와 어긋나 "center" 라고 하는 셀이 있어, 논리값만 믿으면 표가
  // 뒤죽박죽이 된다. override 가 없을 때만 논리 alignment 사용. justify(양쪽)는 트리 미리보기처럼
  // 좌측 취급(생략) — CSS text-align:justify 는 다줄 한글에서 글자 간격이 벌어져 지저분.
  const align = alignOverride !== undefined ? alignOverride : paraProps?.alignment;
  if (align === "center" || align === "right") css.push(`text-align:${align}`);
  if (typeof paraProps?.lineSpacing === "number" && paraProps.lineSpacingType === "Percent") {
    css.push(`line-height:${(paraProps.lineSpacing / 100).toFixed(2)}`);
  }
  const cc = charCss(charProps);
  if (cc) css.push(cc);
  return css.join(";");
}

/** 편집 가능한 문단 한 개: 미리보기 스타일 + 앵커. inner 텍스트는 esc(text) 그대로(복원 동등성). */
function editablePara(text: string, charProps: any, paraProps: any, anchorAttr: string): string {
  const inner = text ? esc(text) : "<br>";
  return `<p ${anchorAttr} style="${paraEditCss(charProps, paraProps)}">${inner}</p>`;
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
  row: number; col: number; rowSpan: number; colSpan: number; props: any; html: string; bg?: string;
}

/**
 * 표 한 개 → <table> HTML. **getCellInfo 의 실제 row/col/span 으로 그리드를 재구성**(셀을 행우선
 * 순차로 깔면 병합셀 표가 깨진다). 열 너비는 <colgroup>(colSpan==1 셀의 width)로 지정.
 */
function renderRhwpTable(doc: RhwpDoc, s: number, p: number, t: TableRef, opts: { editable?: boolean; alignMap?: Map<string, string> } = {}): string {
  const cells: GridCell[] = [];
  for (let idx = 0; idx < t.cells; idx++) {
    const info = doc.getCellInfo ? pj<any>(safe(() => doc.getCellInfo!(s, p, t.ci, idx))) : null;
    const props = doc.getCellProperties ? pj<any>(safe(() => doc.getCellProperties!(s, p, t.ci, idx))) : null;
    const cpc = safe(() => doc.getCellParagraphCount(s, p, t.ci, idx)) ?? 0;
    // 셀의 시각 정렬(트리 lineAlign) — hwpx 논리 alignment 불일치 보정. 셀 단위(첫 줄 기준).
    const vAlign = opts.editable && opts.alignMap
      ? opts.alignMap.get(`${p}|${t.ci}|${info?.row ?? 0}|${info?.col ?? 0}`)
      : undefined;
    let inner = "";
    for (let cp = 0; cp < cpc; cp++) {
      const l = safe(() => doc.getCellParagraphLength(s, p, t.ci, idx, cp)) ?? 0;
      const text = l > 0 ? safe(() => doc.getTextInCell(s, p, t.ci, idx, cp, 0, l)) ?? "" : "";
      const cc = doc.getCellCharPropertiesAt ? pj(safe(() => doc.getCellCharPropertiesAt!(s, p, t.ci, idx, cp, 0))) : null;
      const pcp = doc.getCellParaPropertiesAt ? pj(safe(() => doc.getCellParaPropertiesAt!(s, p, t.ci, idx, cp))) : null;
      if (opts.editable) {
        // 셀 문단을 미리보기 스타일로 입히되 앵커(data-hc)로 복원 가능하게. idx = 논리 셀 인덱스
        // (getCellInfo/getTextInCell 과 동일) → 병합표도 정확히 짝지어진다. 정렬은 시각값(vAlign) 우선.
        inner += `<div data-hc="${s},${p},${t.ci},${idx},${cp}" style="${paraEditCss(cc, pcp, vAlign)}">${esc(text) || "<br>"}</div>`;
        // 셀이 품은 중첩표(표 안의 표)도 편집 가능하게.
        inner += renderNestedTablesEditable(doc, s, p, [[t.ci, idx, cp]]);
      } else {
        inner += renderPara(text, cc, pcp);
      }
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
  const sty = (totalW > 0 ? `width:${totalW}px;` : "") + (opts.editable ? "table-layout:fixed" : "");
  const widthStyle = sty ? ` style="${sty}"` : "";
  const cls = opts.editable ? "hp-tbl hwp-tbl" : "hp-tbl";
  const anchor = opts.editable ? ` data-ht="${s},${p},${t.ci}"` : "";
  return `<table class="${cls}"${anchor}${widthStyle}>${colgroup}<tbody>\n${trs}</tbody></table>`;
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

/** SVG 의 모든 <text> 글자를 읽기순서로 이어붙인 "글자 수프"(공백제거). 렌더 누락 판별용.
 *  (검증 하베스트 scripts/hwp-verify.ts 가 Tier A SVG 누락 판정에 재사용 — 단일 출처.) */
export function svgGlyphSoup(svgs: string[]): string {
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
 * **SVG 충실 미리보기(권장 주 경로)** — rhwp 의 `renderPageSvg` 를 페이지별로 그대로 쌓는다.
 * SVG 렌더러는 원본 좌표·여백·줄바꿈·수식·표·글뒤 배경을 정확히 그린다("동일하게"). renderPageHtml
 * 은 본문을 우측으로 밀어 잘리는 수평 결함이 있어 쓰지 않는다(SVG 는 그 결함이 없음 — 브라우저
 * 실측 검증 scripts/shot.ts 로 확인). 절대좌표를 안 만지는 흐름배치(tree)와 달리 픽셀 충실하다.
 * SVG 가 비거나(렌더 불가) 실패하면 흐름배치 `hwpToTreePreviewHtml` 로 폴백한다.
 */
export function hwpToSvgPreviewHtml(
  doc: RhwpDoc,
  opts: { title?: string; rawBytes?: Uint8Array } = {},
): string {
  const n = doc.pageCount ? safe(() => doc.pageCount!()) ?? 0 : 0;
  const pages: string[] = [];
  if (doc.renderPageSvg) {
    for (let i = 0; i < n; i++) {
      const svg = safe(() => doc.renderPageSvg!(i));
      // 과대 SVG(대용량 이미지 임베드)는 건너뛰되 페이지 자리는 유지하지 않는다(브라우저 보호).
      if (svg && svg.length < 16_000_000) pages.push(`<div class="hp-paper">${svg}</div>`);
    }
  }
  // SVG 렌더 불가 → 흐름배치 트리 미리보기로 폴백(안전망).
  if (pages.length === 0) return hwpToTreePreviewHtml(doc, opts);
  const title = esc(opts.title ?? "한글 미리보기");
  return `<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><title>${title}</title>
<style>
  body{margin:0;background:#eceef0;padding:24px 0;font-family:'맑은 고딕','Malgun Gothic','Apple SD Gothic Neo',sans-serif}
  .hp-paper{margin:0 auto 22px;background:#fff;width:fit-content;max-width:97%;
    box-shadow:0 1px 4px rgba(0,0,0,.12),0 8px 24px rgba(0,0,0,.10)}
  .hp-paper svg{display:block;max-width:100%;height:auto}
</style></head><body>${pages.join("\n")}</body></html>`;
}

/**
 * renderPageHtml 한 페이지에서 "콘텐츠가 페이지 높이 밖으로 얼마나 밀렸는지"(px)를 잰다.
 * rhwp 는 '글 뒤(behind)' floating 배경(예: 상장 테두리)을 흐름 공간으로 잘못 계산해 본문을
 * 프레임 높이만큼 아래로 밀어버리는 버그가 있다 → 페이지 높이 고정+overflow:hidden 에 잘려
 * 텍스트가 통째로 사라진다. 이 값이 크면 그 버그에 걸린 페이지다.
 */
export function pageContentOverflow(pageHtml: string): number {
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
  // (텍스트 잘림) → 트리 미리보기로 폴백(절대좌표 안 써서 안 잘리고, 중첩표·셀이미지도 살린다).
  // 임계값 200px(약 페이지 높이의 18%).
  if (rendered.length === 0 || worstOverflow > 200) return hwpToTreePreviewHtml(doc, opts);

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

// ─────────────────────────────────────────────────────────────────────────────
// 트리 미리보기(hwpToTreePreviewHtml): rhwp getPageRenderTree(계층)를 그대로 흐름 HTML 로.
// 중첩표(표 안의 표)·셀 안 이미지를 올바른 셀에 렌더한다. 절대 y 좌표는 안 쓰고(상장류 텍스트
// 밀림 버그 회피) 계층(읽기 순서)으로 배치한다. 글자 스타일은 getPageTextLayout 런(bbox 매칭),
// 최상위 셀 배경/테두리/병합은 getCellProperties/getCellInfo, 이미지 바이트는 BinData 풀(순서).
// ─────────────────────────────────────────────────────────────────────────────

interface TNode {
  type: string;
  bbox?: { x: number; y: number; w: number; h: number };
  text?: string;
  pi?: number; ci?: number; rows?: number; cols?: number;
  row?: number; col?: number;
  children?: TNode[];
}

/** 페이지 이미지(rhwp renderPageHtml 가 binItemID 로 올바르게 해석해 임베드한 것 + 위치). */
interface PageImg { x: number; y: number; src: string; used: boolean }

/** 셀 배경(rhwp renderPageHtml 의 색칠된 절대배치 div). 셀 bbox 로 매칭해 배경색 적용. */
interface CellBg { x: number; y: number; color: string }

interface TreeCtx {
  doc: RhwpDoc;
  styles: Map<string, string>; // "x,y"(소수1자리) → run CSS
  leadX: Map<string, number>;  // "x,y" → 텍스트에 합쳐진 선행 공백 픽셀폭(탭 정렬 보존)
  pageImgs: PageImg[];         // 현재 페이지의 rhwp 임베드 이미지(위치 매칭용) — 정답 바이트
  cellBgs: CellBg[];           // 현재 페이지의 셀 배경색(위치 매칭용) — 중첩표 헤더색 등
  pool: string[];              // BinData 이미지 data URI(폴백; 이름순이라 순서 부정확)
  cur: { i: number };          // 풀 커서(문서 전역 공유; 폴백용)
  sec: number;                 // 섹션(보통 0)
  pageW: number; pageH: number; // 용지 px(쪽배경 그림 판정용)
  bgLayers: string[];          // 페이지 대부분 덮는 그림(테두리/워터마크) → 절대배치 배경으로 올림
  skipImage?: TNode;           // 쪽배경 페이지에서 배경 그림 노드(절대배치로 따로 그림)를 흐름에서 제외
}

/**
 * rhwp renderPageHtml(pg) 의 <img>(절대배치)에서 위치+바이트를 뽑는다. ⚠ BinData 이름순(BIN0001..)
 * 은 문서 읽기순서와 다를 수 있어(이 파일은 12개 중 11개가 어긋남) 풀-인덱스 매칭이 틀린다.
 * renderPageHtml 은 rhwp 가 그림 컨트롤→binItemID→스트림을 정확히 해석해 임베드하므로, 그
 * <img> 위치(left/top)를 트리 Image 노드 bbox 와 맞추면 각 노드의 **정답 바이트**를 얻는다.
 */
function buildPageImages(doc: RhwpDoc, pg: number): PageImg[] {
  const html = doc.renderPageHtml ? safe(() => doc.renderPageHtml!(pg)) : undefined;
  if (!html) return [];
  const out: PageImg[] = [];
  for (const m of html.matchAll(/<img\b[^>]*>/g)) {
    const tag = m[0];
    const src = tag.match(/src="(data:[^"]+)"/)?.[1];
    const x = Number(tag.match(/left:(-?[\d.]+)px/)?.[1]); // 음수 좌표(페이지 밖 일부)도 매칭
    const y = Number(tag.match(/top:(-?[\d.]+)px/)?.[1]);
    if (src && isFinite(x) && isFinite(y)) out.push({ x, y, src, used: false });
  }
  return out;
}

/** 투명 1×1 GIF — 바이트 없는(빈) 그림틀의 자리표시자. 트리 Image 노드는 절대 드롭하지 않는다. */
const TRANSPARENT_PX =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

/**
 * 트리 Image 노드 → 표시할 src. 우선순위:
 *   ① bbox 로 renderPageHtml 의 <img>(정답 바이트) 매칭
 *   ② renderPageHtml 이 이 페이지에 <img> 를 **하나도** 못 내보낸 경우(=floating 등으로 미지원)
 *      에 한해 BinData 풀에서 문서순으로 보충(순서 근사). renderPageHtml 이 일부라도 <img> 를
 *      낸 페이지에서 매칭에 실패한 노드는 "바이트 없는 빈 그림틀"(binItemID=0 placeholder 등)이
 *      므로 풀에서 엉뚱한 바이트를 빌리지 않고 ③ 투명 자리표시자로 둔다.
 *   ③ 투명 1×1 자리표시자(드롭 금지). 어느 경우든 <img> 는 항상 1개 나간다.
 */
function imageSrcFor(node: TNode, ctx: TreeCtx): string {
  const b = node.bbox;
  if (b) {
    let best = -1, bestD = 5; // 5px 임계(같은 레이아웃 엔진이라 보통 0.1px 이내로 일치)
    for (let i = 0; i < ctx.pageImgs.length; i++) {
      const im = ctx.pageImgs[i]!;
      if (im.used) continue;
      const d = Math.abs(im.x - b.x) + Math.abs(im.y - b.y);
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best >= 0) { ctx.pageImgs[best]!.used = true; return ctx.pageImgs[best]!.src; }
  }
  // renderPageHtml 이 이 페이지에 <img> 를 0개 낸 경우에만 BinData 풀로 보충(미지원/실패 폴백).
  // (일부라도 낸 페이지의 미매칭 노드는 빈 그림틀이므로 풀에서 빌리지 않는다.)
  if (ctx.pageImgs.length === 0) {
    const uri = ctx.pool[ctx.cur.i];
    if (uri !== undefined) { ctx.cur.i++; return uri; }
  }
  return TRANSPARENT_PX; // 바이트 없음 → 투명 자리표시자(노드 드롭 방지)
}

/**
 * renderPageHtml(pg) 의 색칠된 절대배치 div(셀 배경)에서 위치+색을 뽑는다. 중첩표 헤더색 등은
 * getCellProperties(최상위만)·렌더트리(색 없음)로 못 얻지만 renderPageHtml 엔 칠해져 있다.
 * 흰색(#ffffff)/페이지 전체배경은 제외. 셀 bbox 좌상단과 매칭해 <td> 배경으로 쓴다.
 */
function buildCellBgs(doc: RhwpDoc, pg: number): CellBg[] {
  const html = doc.renderPageHtml ? safe(() => doc.renderPageHtml!(pg)) : undefined;
  if (!html) return [];
  const out: CellBg[] = [];
  for (const m of html.matchAll(/<(?:div|td)\b[^>]*style="([^"]*)"[^>]*>/g)) {
    const st = m[1]!;
    const color = st.match(/background(?:-color)?:\s*(#[0-9a-fA-F]{6})/)?.[1];
    if (!color || color.toLowerCase() === "#ffffff") continue;
    const x = Number(st.match(/left:(-?[\d.]+)px/)?.[1]);
    const y = Number(st.match(/top:(-?[\d.]+)px/)?.[1]);
    const w = Number(st.match(/width:([\d.]+)px/)?.[1]);
    const h = Number(st.match(/height:([\d.]+)px/)?.[1]);
    // 페이지 전체를 덮는 배경(쪽 배경)은 셀이 아니므로 제외.
    if (!isFinite(x) || !isFinite(y) || (w > 700 && h > 1000)) continue;
    out.push({ x, y, color });
  }
  return out;
}

/** 셀 bbox 좌상단에 가장 가까운(3px 내) 배경색. */
function cellBgFor(bbox: TNode["bbox"], ctx: TreeCtx): string | undefined {
  if (!bbox) return undefined;
  let best: string | undefined, bestD = 3;
  for (const c of ctx.cellBgs) {
    const d = Math.abs(c.x - bbox.x) + Math.abs(c.y - bbox.y);
    if (d < bestD) { bestD = d; best = c.color; }
  }
  return best;
}

/**
 * 줄 정렬을 기하로 유도(rhwp 가 정렬필드를 안 줌). ⚠ TextLine bbox 는 문단 **내용영역 전체폭**(셀
 * 안에서 거의 가운데)이라 그걸 쓰면 다 가운데가 된다. 실제 정렬은 **글자(run) 위치**로 본다:
 * 줄 내용박스(line.bbox) 안에서 글자뭉치가 왼쪽 붙음=left, 오른쪽 붙음=right, 가운데=center.
 */
function lineAlign(line: TNode): string {
  const box = line.bbox;
  const runs = (line.children ?? []).filter((c) => c.type === "TextRun" && c.bbox && (c.text ?? "").length);
  if (!box || box.w <= 0 || !runs.length) return "";
  const textLeft = Math.min(...runs.map((r) => r.bbox!.x));
  const textRight = Math.max(...runs.map((r) => r.bbox!.x + r.bbox!.w));
  const leftGap = textLeft - box.x;
  const rightGap = (box.x + box.w) - textRight;
  const tol = Math.max(6, box.w * 0.03);
  if (leftGap <= tol) return "";                                  // 왼쪽(기본)
  if (rightGap <= tol) return "right";                            // 오른쪽
  if (Math.abs(leftGap - rightGap) <= box.w * 0.15) return "center"; // 가운데
  return "";                                                      // 들여쓰기 등은 왼쪽 취급
}

/** getPageTextLayout 런 → CSS 선언. fontSize 는 px(96dpi)이라 ×0.75 로 pt 환산. */
/** 한글 글꼴명 → 폰트 스택. 바탕/명조/궁서 계열은 세리프, 그 외(고딕/굴림/돋움/맑은)는 산세리프 폴백. */
function fontStack(family: string): string {
  const f = family.replace(/'/g, "");
  const serif = /바탕|명조|궁서|신명|Batang|Myeongjo|Gungsuh|Serif/i.test(f);
  return serif
    ? `'${f}','바탕','Batang','Noto Serif KR',serif`
    : `'${f}','맑은 고딕','Malgun Gothic','Noto Sans KR',sans-serif`;
}

function runCss(r: any): string {
  const css: string[] = [];
  if (typeof r.fontSize === "number") css.push(`font-size:${(r.fontSize * 0.75).toFixed(1)}pt`);
  if (r.bold) css.push("font-weight:700");
  if (r.italic) css.push("font-style:italic");
  const deco: string[] = [];
  if (r.underline) deco.push("underline");
  if (r.strikethrough) deco.push("line-through");
  if (deco.length) css.push(`text-decoration:${deco.join(" ")}`);
  const tc = color(r.textColor);
  if (tc && tc !== "#000000") css.push(`color:${tc}`);
  // 자간(letterSpacing, px). HWP 장평(ratio)도 있으나 레이아웃 깨짐 위험으로 자간만 반영.
  if (typeof r.letterSpacing === "number" && Math.abs(r.letterSpacing) > 0.1) {
    css.push(`letter-spacing:${r.letterSpacing.toFixed(1)}px`);
  }
  if (typeof r.fontFamily === "string" && r.fontFamily) css.push(`font-family:${fontStack(r.fontFamily)}`);
  return css.join(";");
}

/** 페이지 텍스트 런 스타일 인덱스(bbox 키 → CSS). 트리 TextRun 의 bbox 로 조회. */
function buildRunStyles(doc: RhwpDoc, pg: number): Map<string, string> {
  const m = new Map<string, string>();
  const tl = doc.getPageTextLayout ? pj<any>(safe(() => doc.getPageTextLayout!(pg))) : null;
  for (const r of (tl?.runs ?? [])) {
    if (typeof r?.x !== "number" || typeof r?.y !== "number") continue;
    m.set(`${r.x.toFixed(1)},${r.y.toFixed(1)}`, runCss(r));
  }
  return m;
}

const runStyleFor = (node: TNode, ctx: TreeCtx): string =>
  node.bbox ? ctx.styles.get(`${node.bbox.x.toFixed(1)},${node.bbox.y.toFixed(1)}`) ?? "" : "";

/**
 * 런 bbox키 → **텍스트에 합쳐진 선행 공백(탭 포함)의 픽셀 폭**. getPageTextLayout 의 글자별 x(charX)
 * 로 첫 비공백 글자의 오프셋을 떼어낸다. 탭 정렬/수동 들여쓰기가 별도 런이 아니라 텍스트 앞에 붙어
 * 있는 줄(예: "33칸+탭+프로젝트…")을 정확한 폭의 스페이서로 바꿔 원본 가로 위치를 보존한다.
 */
function buildRunLeadX(doc: RhwpDoc, pg: number): Map<string, number> {
  const m = new Map<string, number>();
  const tl = doc.getPageTextLayout ? pj<any>(safe(() => doc.getPageTextLayout!(pg))) : null;
  for (const r of (tl?.runs ?? [])) {
    if (typeof r?.x !== "number" || typeof r?.y !== "number" || !Array.isArray(r.charX)) continue;
    const t: string = typeof r.text === "string" ? r.text : "";
    if (!/^[\s ]/.test(t)) continue;
    const chars = [...t];
    const idx = chars.findIndex((c) => !/[\s ]/.test(c));
    if (idx <= 0) continue; // 전체공백(별도 처리) 또는 선행공백 없음
    const lead = r.charX[idx];
    if (typeof lead === "number" && lead > 0.5) m.set(`${r.x.toFixed(1)},${r.y.toFixed(1)}`, lead);
  }
  return m;
}

/** 트리 노드 → HTML(재귀). inCell: 표 셀 안. cont: 정렬 판정용 담는 가로범위(셀/본문). */
function renderTreeNode(node: TNode, ctx: TreeCtx, inCell: boolean, cont?: { x: number; w: number }): string {
  switch (node.type) {
    case "Table":
      return renderTreeTable(node, ctx, !inCell);
    case "Image": {
      if (ctx.skipImage && node === ctx.skipImage) return ""; // 쪽배경 그림은 절대배치로 따로 그림
      const uri = imageSrcFor(node, ctx); // 위치(bbox) 매칭 → 정답 바이트(폴백: 풀)
      if (!uri) return "";
      const b = node.bbox;
      // (쪽배경 그림이 있는 페이지는 renderAbsBgPage 가 따로 처리 → 여기 안 옴.)
      const dim = b && b.w > 0 && b.h > 0 ? `width:${Math.round(b.w)}px;height:${Math.round(b.h)}px;` : "";
      return `<div class="hp-img"><img alt="" style="${dim}max-width:100%" src="${uri}"></div>`;
    }
    case "TextLine": {
      // 줄 안의 글자(TextRun)와 **글자처럼 박힌 그림(Image)** 을 함께 렌더(그림 누락 방지).
      const html = (node.children ?? [])
        .map((c) => {
          if (c.type === "TextRun") {
            const raw = c.text ?? "";
            // 공백·탭만으로 된 런(탭 정렬·수동 들여쓰기 등)은 HTML 이 공백을 접어 위치가 무너진다.
            // → 런 bbox 폭만큼의 스페이서로 대체해 원본 가로 위치를 보존(예: "프로젝트 팀(원)…" 우측배치).
            if (raw.length > 0 && /^[\s ]+$/.test(raw) && c.bbox && c.bbox.w > 0) {
              return `<span style="display:inline-block;width:${Math.round(c.bbox.w)}px"></span>`;
            }
            const st = runStyleFor(c, ctx);
            const style = st ? `${st};white-space:pre-wrap` : "white-space:pre-wrap";
            // 텍스트에 합쳐진 선행 공백 → charX 기반 정확폭 스페이서 + 나머지 텍스트
            // (별도 런이 아니라 "33칸+탭+프로젝트…"처럼 텍스트 앞에 붙어 안 잡히던 케이스).
            const lead = c.bbox ? ctx.leadX.get(`${c.bbox.x.toFixed(1)},${c.bbox.y.toFixed(1)}`) : undefined;
            if (lead && /^[\s ]/.test(raw)) {
              const ch = [...raw];
              const i = ch.findIndex((x) => !/[\s ]/.test(x));
              if (i > 0) {
                const rest = esc(ch.slice(i).join(""));
                return `<span style="display:inline-block;width:${Math.round(lead)}px"></span><span style="${style}">${rest}</span>`;
              }
            }
            // 런 내부 연속 공백(수동 간격)도 보존: white-space:pre-wrap.
            return `<span style="${style}">${esc(raw)}</span>`;
          }
          if (c.type === "Image") {
            const uri = imageSrcFor(c, ctx);
            if (!uri) return "";
            const b = c.bbox;
            const dim = b && b.w > 0 && b.h > 0 ? `width:${Math.round(b.w)}px;height:${Math.round(b.h)}px;` : "";
            return `<img alt="" style="${dim}max-width:100%;vertical-align:top" src="${uri}">`;
          }
          return "";
        })
        .join("");
      const styles: string[] = [];
      const align = lineAlign(node);
      if (align) styles.push(`text-align:${align}`);
      // 빈 줄(원본의 빈 문단)은 그 높이만큼 세로공간 확보 → 원본 줄간격/배치 보존.
      if (!html && node.bbox && node.bbox.h > 0) styles.push(`height:${Math.round(node.bbox.h)}px`);
      const style = styles.length ? ` style="${styles.join(";")}"` : "";
      return `<div class="hp-ln"${style}>${html || "<br>"}</div>`;
    }
    case "TextRun":
      return esc(node.text ?? "");
    case "Header": case "Footer":
      // 머리말/꼬리말(쪽번호 등)은 흐름이 아니라 **실제 좌표로 절대배치**(페이지 상/하단 고정).
      return renderHeaderFooter(node, ctx);
    case "PageBg": case "Rect": case "Line":
      return ""; // 장식(배경/셀선) — 색은 셀 스타일에서 따로 취득
    default:
      // Page, Body, Column, Group, Cell 등 → 자식 이어붙임
      return (node.children ?? []).map((c) => renderTreeNode(c, ctx, inCell, cont)).join("");
  }
}

/** 머리말/꼬리말 안 글줄을 실제 좌표(글자 x, 줄 y)로 절대배치한 div 들로. 쪽번호는 가운데 등 원본대로. */
function renderHeaderFooter(node: TNode, ctx: TreeCtx): string {
  const out: string[] = [];
  (function walk(n: TNode) {
    if (!n || typeof n !== "object") return;
    if (n.type === "TextLine") {
      const runs = (n.children ?? []).filter((c) => c.type === "TextRun" && c.bbox && (c.text ?? "").length);
      if (runs.length && n.bbox) {
        const minX = Math.min(...runs.map((r) => r.bbox!.x));
        const inner = runs.map((r) => {
          const st = runStyleFor(r, ctx);
          const t = esc(r.text ?? "");
          return st ? `<span style="${st}">${t}</span>` : t;
        }).join("");
        out.push(`<div class="hp-hf" style="left:${Math.round(minX)}px;top:${Math.round(n.bbox.y)}px">${inner}</div>`);
      }
      return;
    }
    if (n.type === "Image" && n.bbox) {
      const uri = imageSrcFor(n, ctx);
      if (uri) {
        out.push(`<img class="hp-hf" alt="" style="left:${Math.round(n.bbox.x)}px;top:${Math.round(n.bbox.y)}px;` +
          `width:${Math.round(n.bbox.w)}px;height:${Math.round(n.bbox.h)}px" src="${uri}">`);
      }
      return;
    }
    for (const k of (n.children ?? [])) walk(k);
  })(node);
  return out.join("");
}

/**
 * 트리 Table → <table>. topLevel 이면 getCellInfo(병합)/getCellProperties(배경·테두리)로 보강.
 * ⚠ 렌더트리는 **페이지에 보이는 셀만**(표가 여러 페이지에 걸치면 일부만) 담는데, getCellInfo(k)
 * 는 전체 논리셀을 0부터 센다 → 인덱스로 짝지으면 어긋난다. 그래서 (row,col)로 짝짓는다:
 * 전체 논리셀의 (row,col)→{info,props} 맵을 만들고, 각 트리 셀을 자기 (row,col)로 조회한다.
 */
function renderTreeTable(node: TNode, ctx: TreeCtx, topLevel: boolean): string {
  const cellNodes = (node.children ?? []).filter((c) => c.type === "Cell");
  const cols = node.cols && node.cols > 0 ? node.cols : 1;
  const hasIds = typeof node.pi === "number" && typeof node.ci === "number";

  // 전체 논리셀의 속성을 (row,col)로 색인(최상위 표만 — 중첩표는 pi/ci 가 없어 트리값 사용).
  const byRC = new Map<string, { info: any; props: any }>();
  if (topLevel && hasIds && ctx.doc.getCellInfo) {
    const dims = ctx.doc.getTableDimensions
      ? pj<any>(safe(() => ctx.doc.getTableDimensions!(ctx.sec, node.pi!, node.ci!))) : null;
    const total = typeof dims?.cellCount === "number" ? dims.cellCount : cellNodes.length;
    for (let k = 0; k < total; k++) {
      const info = pj<any>(safe(() => ctx.doc.getCellInfo!(ctx.sec, node.pi!, node.ci!, k)));
      if (!info || typeof info.row !== "number" || typeof info.col !== "number") continue;
      const props = ctx.doc.getCellProperties
        ? pj<any>(safe(() => ctx.doc.getCellProperties!(ctx.sec, node.pi!, node.ci!, k))) : null;
      byRC.set(`${info.row},${info.col}`, { info, props });
    }
  }

  const grid: GridCell[] = cellNodes.map((cell) => {
    const row = cell.row ?? 0, col = cell.col ?? 0;
    const m = byRC.get(`${row},${col}`);
    const rs = m?.info?.rowSpan, cs = m?.info?.colSpan;
    // 셀 내용은 셀 가로범위(bbox)를 정렬 기준으로 렌더.
    const cont = cell.bbox ? { x: cell.bbox.x, w: cell.bbox.w } : undefined;
    const inner = (cell.children ?? []).map((c) => renderTreeNode(c, ctx, true, cont)).join("");
    return {
      row, col, // 배치는 트리 좌표(페이지에 보이는 그대로)
      rowSpan: typeof rs === "number" && rs > 0 ? rs : 1,
      colSpan: typeof cs === "number" && cs > 0 ? cs : 1,
      props: m?.props ?? null,
      bg: cellBgFor(cell.bbox, ctx), // renderPageHtml 에서 추출한 셀 배경색(중첩표 헤더 등)
      html: inner || "<br>",
    };
  });
  return assembleTreeTable(grid, cols, topLevel);
}

/** 그리드 셀 배열 → <table> HTML(병합/열너비 처리). renderRhwpTable 의 조립부와 동일 규칙. */
function assembleTreeTable(cells: GridCell[], cols: number, topLevel: boolean): string {
  const colW = new Array(Math.max(cols, 1)).fill(0);
  for (const c of cells) {
    if (c.colSpan === 1 && c.col < colW.length && typeof c.props?.width === "number") {
      colW[c.col] = Math.max(colW[c.col], hu2px(c.props.width));
    }
  }
  const totalW = colW.reduce((a, b) => a + b, 0);
  const colgroup = totalW > 0
    ? `<colgroup>${colW.map((w) => `<col style="width:${w || 40}px">`).join("")}</colgroup>` : "";
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
        // 최상위 셀은 원본 배경/테두리(cellCss), 중첩 셀은 API 부재라 기본 테두리.
        const base = c.props ? cellCss(c.props) : "border:1px solid #bbb;padding:3px 6px;vertical-align:top";
        // renderPageHtml 에서 추출한 셀 배경색으로 보강(중첩표 헤더색 등 — cellCss 가 못 얻는 것).
        const css = c.bg ? `${base};background:${c.bg}` : base;
        return `<td${span} style="${css}">${c.html}</td>`;
      })
      .join("");
    trs += `<tr>${tds}</tr>\n`;
  }
  const cls = topLevel ? "hp-tbl" : "hp-tbl hp-nested";
  const widthStyle = totalW > 0 ? ` style="width:${totalW}px"` : "";
  return `<table class="${cls}"${widthStyle}>${colgroup}<tbody>\n${trs}</tbody></table>`;
}

/** 페이지 60%↑ 덮는 그림(쪽배경: 상장 테두리·워터마크)을 찾는다(가장 큰 것). 없으면 null. */
function findFullPageBg(root: TNode, pageW: number, pageH: number): TNode | null {
  let best: TNode | null = null;
  let bestArea = 0;
  let qualifying = 0; // 페이지 60%↑ 그림 개수
  (function walk(n: TNode) {
    if (!n || typeof n !== "object") return;
    const b = n.bbox;
    // 진짜 쪽배경(상장 테두리·워터마크)은 페이지 폭/높이의 60~110% 안에서 페이지를 "감싼다".
    // 페이지보다 훨씬 큰 그림(예: 용지폭 320%·높이 105%로 넘치는 본문 스크린샷)은 배경이
    // 아니라 콘텐츠이므로 쪽배경 처리에서 제외(그래야 같은 페이지의 다른 그림이 안 드롭된다).
    if (
      n.type === "Image" && b &&
      b.w >= pageW * 0.6 && b.h >= pageH * 0.6 &&
      b.w <= pageW * 1.1 && b.h <= pageH * 1.1
    ) {
      qualifying++;
      if (b.w * b.h > bestArea) { bestArea = b.w * b.h; best = n; }
    }
    for (const k of (n.children ?? [])) walk(k);
  })(root);
  // ⚠ 진짜 쪽배경(상장 테두리·워터마크)은 페이지당 **하나**다. 큰 그림이 2개 이상이면
  //   배경이 아니라 **큰 콘텐츠 도판들**(예: "8-2 번문제 해석" 풀이 도판 4장)이므로 쪽배경
  //   처리하면 안 된다(하나만 배경 깔고 나머지 드롭됨) → null 로 일반 흐름배치 시킨다.
  return qualifying >= 2 ? null : best;
}

const median = (a: number[]): number => (a.length ? a.slice().sort((x, y) => x - y)[a.length >> 1]! : 0);

/**
 * 쪽배경 그림 페이지(상장 등). rhwp 의 텍스트 **좌표**는 '글 뒤 배경'을 흐름으로 오계산해 페이지
 * 밖으로 밀려있어 못 쓴다. 대신 **실제 파싱된 문단값을 그대로** 쓴다: 표 셀의 각 문단을
 * getCellParaPropertiesAt(정렬)·getCellCharPropertiesAt(글자속성)·getTextInCell(텍스트)로 읽어
 * `renderPara` 로 흘려 배치. 가로 내용영역(x/너비)은 트리 TextLine bbox 중앙값(원본 글 영역).
 * 배경 그림은 글 뒤(절대배치), 본문은 용지 안에서 세로 가운데.
 */
function renderBgPageFlow(tree: TNode, bg: TNode, ctx: TreeCtx): string {
  const bb = bg.bbox!;
  const bgUri = imageSrcFor(bg, ctx);
  const bgImg = bgUri
    ? `<img class="hp-bg" alt="" style="left:${Math.round(bb.x)}px;top:${Math.round(bb.y)}px;` +
      `width:${Math.round(bb.w)}px;height:${Math.round(bb.h)}px" src="${bgUri}">`
    : "";
  // 최상위 콘텐츠 표 수집.
  const tables: TNode[] = [];
  (function f(n: TNode) {
    if (!n || typeof n !== "object") return;
    if (n.type === "Table" && typeof n.pi === "number") tables.push(n);
    for (const k of (n.children ?? [])) f(k);
  })(tree);

  // ⚠ 단일 표(상장 등) → 셀 문단값으로 중앙배치(쪽배경 페이지는 트리 bbox 정렬추측이 틀려서
  //   getCell*PropertiesAt 실값을 씀). **복수 표/복합 콘텐츠**(예: 제안요청서 = 표 2개 + 제목)
  //   → 전체 트리를 흐름 렌더(배경 그림만 절대배치로 빼고 스킵). 예전엔 첫 표 하나만 그려
  //   나머지 표·평문이 통째로 드롭됐다(텍스트 46.5%만 렌더).
  const t = tables.length === 1 ? tables[0]! : null;
  if (t && typeof t.ci === "number") {
    // 가로 내용영역 = 글 있는 TextLine bbox 의 중앙값(셀 안 실제 글 영역).
    const xs: number[] = [], rs: number[] = [];
    (function f(n: TNode) {
      if (!n || typeof n !== "object") return;
      if (n.type === "TextLine" && n.bbox && (n.children ?? []).some((c) => c.type === "TextRun" && (c.text ?? "").length)) {
        xs.push(n.bbox.x); rs.push(n.bbox.x + n.bbox.w);
      }
      for (const k of (n.children ?? [])) f(k);
    })(tree);
    const cx = median(xs), cw = Math.max(1, median(rs) - cx);
    let body = "";
    const dims = ctx.doc.getTableDimensions ? pj<any>(safe(() => ctx.doc.getTableDimensions!(ctx.sec, t.pi!, t.ci!))) : null;
    const cells = typeof dims?.cellCount === "number" ? dims.cellCount : 1;
    for (let cell = 0; cell < cells; cell++) {
      const cpc = safe(() => ctx.doc.getCellParagraphCount(ctx.sec, t.pi!, t.ci!, cell)) ?? 0;
      for (let cp = 0; cp < cpc; cp++) {
        const len = safe(() => ctx.doc.getCellParagraphLength(ctx.sec, t.pi!, t.ci!, cell, cp)) ?? 0;
        const text = len > 0 ? safe(() => ctx.doc.getTextInCell(ctx.sec, t.pi!, t.ci!, cell, cp, 0, len)) ?? "" : "";
        const cc = ctx.doc.getCellCharPropertiesAt ? pj(safe(() => ctx.doc.getCellCharPropertiesAt!(ctx.sec, t.pi!, t.ci!, cell, cp, 0))) : null;
        const pcp = ctx.doc.getCellParaPropertiesAt ? pj(safe(() => ctx.doc.getCellParaPropertiesAt!(ctx.sec, t.pi!, t.ci!, cell, cp))) : null;
        body += renderPara(text, cc, pcp);
      }
    }
    return `<div class="hp-page hp-bgpage">${bgImg}` +
      `<div class="hp-body" style="margin-left:${Math.round(cx)}px;width:${Math.round(cw)}px">${body}</div></div>`;
  }

  // 복수 표/복합 콘텐츠: 배경은 절대배치(뒤), 본문은 전체 트리를 흐름 렌더(배경 그림 노드만 스킵).
  ctx.skipImage = bg;
  const content = renderTreeNode(tree, ctx, false);
  ctx.skipImage = undefined;
  return `<div class="hp-page hp-bgpage">${bgImg}<div class="hp-body">${content}</div></div>`;
}

/**
 * rhwp getPageRenderTree 를 페이지별로 흐름 HTML 로 렌더하는 **트리 미리보기**.
 * 중첩표·셀 안 이미지를 올바른 셀에 그리고, 최상위 셀은 배경/테두리/병합/글자스타일까지 원본대로.
 * 쪽배경(상장 테두리) 페이지는 글자 실제좌표로 절대배치.
 * (getPageRenderTree 미지원/빈 결과 시 흐름배치 hwpToRichPreviewHtml 로 폴백.)
 */
export function hwpToTreePreviewHtml(
  doc: RhwpDoc,
  opts: { title?: string; rawBytes?: Uint8Array } = {},
): string {
  const n = doc.pageCount && doc.getPageRenderTree ? safe(() => doc.pageCount!()) ?? 0 : 0;
  const pageDef = doc.getPageDef ? pj<any>(safe(() => doc.getPageDef!(0))) : null;
  const pageW = pageDef && pageDef.width ? hu2px(pageDef.width) : 794;
  const pageH = pageDef && pageDef.height ? hu2px(pageDef.height) : 1123;
  const mL = hu2px(pageDef?.marginLeft ?? 0), mR = hu2px(pageDef?.marginRight ?? 0);
  const pad = pageDef
    ? `${hu2px(pageDef.marginTop ?? 0)}px ${mR}px ${hu2px(pageDef.marginBottom ?? 0)}px ${mL}px`
    : "40px 44px";
  // 본문 텍스트 정렬 판정용 페이지 내용영역(좌여백~우여백) — 절대 페이지좌표 기준.
  const bodyCont = { x: mL, w: Math.max(1, pageW - mL - mR) };

  const pool = opts.rawBytes ? extractHwpBinImages(opts.rawBytes) : [];
  const cur = { i: 0 };
  const pages: string[] = [];
  for (let pg = 0; pg < n; pg++) {
    const tree = pj<TNode>(safe(() => doc.getPageRenderTree!(pg)));
    if (!tree) continue;
    const ctx: TreeCtx = {
      doc, styles: buildRunStyles(doc, pg), leadX: buildRunLeadX(doc, pg), pageImgs: buildPageImages(doc, pg),
      cellBgs: buildCellBgs(doc, pg), pool, cur, sec: 0, pageW, pageH, bgLayers: [],
    };
    // 쪽배경(상장 테두리 등) 페이지 → 실제 문단값으로 흐름배치. 그 외 → 일반 흐름배치.
    const bg = findFullPageBg(tree, pageW, pageH);
    pages.push(bg ? renderBgPageFlow(tree, bg, ctx) : `<div class="hp-page">${renderTreeNode(tree, ctx, false, bodyCont)}</div>`);
  }
  // 트리 미지원/실패 → 기존 흐름배치 미리보기로 폴백(안전망).
  if (pages.length === 0) return hwpToRichPreviewHtml(doc, opts);

  const title = esc(opts.title ?? "한글 미리보기");
  return `<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><title>${title}</title>
<style>
  body{margin:0;background:#eceef0;padding:24px 0;font-family:'맑은 고딕','Malgun Gothic','Apple SD Gothic Neo',sans-serif;color:#111}
  /* 각 페이지는 원본 용지(A4 등) 비율로: 폭 고정 + 용지 높이만큼 min-height(짧은 페이지도 종이처럼). */
  .hp-page{position:relative;width:${pageW}px;min-height:${pageH}px;max-width:96%;margin:0 auto 22px;background:#fff;padding:${pad};
    box-shadow:0 1px 4px rgba(0,0,0,.12),0 8px 24px rgba(0,0,0,.10);line-height:1.5;font-size:10.5pt;box-sizing:border-box}
  /* 쪽배경(상장 테두리) 페이지: 그림은 글 뒤(절대), 본문은 실제 내용영역에서 세로 가운데. */
  .hp-bgpage{padding:0;display:flex;flex-direction:column;justify-content:center}
  .hp-bg{position:absolute;z-index:0;pointer-events:none}
  .hp-bgpage .hp-body{position:relative;z-index:1}
  .hp-tbl{border-collapse:collapse;table-layout:fixed;margin:8px 0;max-width:100%}
  .hp-tbl td{vertical-align:middle;padding:2px 5px;word-break:break-word;overflow-wrap:anywhere}
  .hp-tbl.hp-nested{margin:3px 0;width:100%}
  .hp-ln{min-height:1em}
  /* 머리말/꼬리말(쪽번호 등)은 페이지 상/하단 실제 좌표에 고정(흐름과 무관). */
  .hp-hf{position:absolute;z-index:2;white-space:nowrap}
  /* 이미지는 inline-block 으로 — 같은 줄에 들어가면 옆으로, 넘치면 아래로(원본의 가로/세로 배치 근사). */
  .hp-img{display:inline-block;vertical-align:top;margin:4px 6px 4px 0}
  .hp-img img{display:block}
</style></head><body>${pages.join("\n")}</body></html>`;
}
