/**
 * xlsx 포맷 어댑터 — 현재 미리보기(읽기) 전용. 왕복(encode/decode)은 로드맵.
 *
 * xlsx 구조: xl/workbook.xml(시트 목록) + xl/worksheets/sheetN.xml(셀·병합) +
 *   xl/sharedStrings.xml(문자열 풀). 셀 c@t="s" 면 값 v 는 sharedStrings 인덱스.
 *
 * 미리보기 원칙(원본 그대로):
 *   - 사용 영역(A1 ~ 최대 행/열) 전체를 그려 **빈 셀도 자리 그대로** 보인다.
 *   - mergeCells(병합)는 colspan/rowspan 으로 합치고 가려진 셀은 건너뛴다.
 *   - 행 번호(1,2,3)·열 문자(A,B,C) 머리행을 붙여 스프레드시트처럼 보이게 한다.
 *   - 가로로 길어도 레이아웃이 안 무너지게 가로 스크롤 컨테이너에 담는다.
 */
import type { FormatAdapter } from "../core/format.js";
import type { Manifest } from "../model/manifest.js";
import { encodeXlsxToHtml } from "../encode/xlsxToHtml.js";
import { decodeHtmlToXlsx } from "../decode/htmlToXlsx.js";
import { readZip, tryPartToText } from "../core/zip.js";
import { parseXml, collectDeep, deepText, childrenOf, findChildren, findChild, findDeep, attrOf, type XmlNode } from "../core/xml.js";
import { toPreviewHtml, type PreviewOptions } from "../preview/preview.js";
import { parseXlsxStyles, type XlsxStyles } from "./xlsx-styles.js";
import { bytesToBase64 } from "../core/base64.js";

// 미리보기 폭주 방지 상한(원본이 더 커도 여기까지만 그린다).
const MAX_ROWS = 400;
const MAX_COLS = 64;

interface Merge { r1: number; c1: number; r2: number; c2: number; }
interface CellVal { t: string; s?: number } // 텍스트 + 스타일 index
interface Grid {
  rows: number;
  cols: number;
  value: Map<string, CellVal>; // "row,col"(0-based) → 값+스타일
  merges: Merge[];
  colW: Map<number, number>; // 열 index(0-based) → px
  rowH: Map<number, number>; // 행 index(0-based) → px
  truncated: boolean;
}

const DEFAULT_COL_PX = 64;
const DEFAULT_ROW_PX = 20; // 엑셀 기본 행 높이(15pt) ≈ 20px
const ROWHEAD_PX = 42;
const EMU_PER_PX = 9525; // 914400 EMU/inch ÷ 96 dpi
/** 엑셀 열 너비(문자 단위) → px 근사. */
const colWidthToPx = (w: number): number => Math.round(w * 7) + 5;
/** 포인트(행 높이) → px. */
const ptToPx = (pt: number): number => Math.round((pt * 96) / 72);
/** EMU → px(96dpi). */
const emuToPx = (emu: number): number => Math.round(emu / EMU_PER_PX);

/** sharedStrings.xml → 문자열 배열. */
function readSharedStrings(parts: Record<string, Uint8Array>): string[] {
  const xml = tryPartToText(parts, "xl/sharedStrings.xml");
  if (!xml) return [];
  return collectDeep(parseXml(xml), "si").map((si) =>
    collectDeep([si], "t")
      .map(deepText)
      .join(""),
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

/** 0-기준 열 index → 열 문자(A, B, …, Z, AA, …). */
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

/** 워크북에서 시트 이름 + 대상 경로(순서대로). */
function sheetList(parts: Record<string, Uint8Array>): { name: string; path: string }[] {
  const wb = tryPartToText(parts, "xl/workbook.xml");
  const names: string[] = [];
  if (wb) for (const s of collectDeep(parseXml(wb), "sheet")) names.push(attrOf(s, "name") ?? `Sheet${names.length + 1}`);
  const paths = Object.keys(parts)
    .filter((p) => /^xl\/worksheets\/sheet\d+\.xml$/.test(p))
    .sort((a, b) => num(a) - num(b));
  return paths.map((path, i) => ({ name: names[i] ?? `Sheet${i + 1}`, path }));
}
const num = (p: string): number => Number(/sheet(\d+)\.xml$/.exec(p)?.[1] ?? 0);

/** 한 시트 XML → 그리드 모델(값·스타일·병합·범위). */
function sheetGrid(xml: string, shared: string[]): Grid {
  const tree = parseXml(xml);
  const value = new Map<string, CellVal>();
  const colW = new Map<number, number>();
  const rowH = new Map<number, number>();
  let maxRow = 0;
  let maxCol = 0;

  // 열 너비(<cols><col min max width/>)
  for (const col of collectDeep(tree, "col")) {
    const w = Number(attrOf(col, "width"));
    if (!Number.isFinite(w)) continue;
    const min = Number(attrOf(col, "min") ?? "1");
    const max = Number(attrOf(col, "max") ?? String(min));
    for (let c = min; c <= max && c - 1 < MAX_COLS; c++) colW.set(c - 1, colWidthToPx(w));
  }

  for (const row of collectDeep(tree, "row")) {
    const rIdx = Number(attrOf(row, "r") ?? "0") - 1;
    const ht = Number(attrOf(row, "ht"));
    if (rIdx >= 0 && Number.isFinite(ht)) rowH.set(rIdx, ptToPx(ht));
    for (const c of findChildren(childrenOf(row), "c")) {
      const { row: r, col } = parseRef(attrOf(c, "r") ?? "A1");
      const type = attrOf(c, "t");
      const sAttr = attrOf(c, "s");
      const s = sAttr !== undefined ? Number(sAttr) : undefined;
      const v = findChild(childrenOf(c), "v");
      const isNode = findChild(childrenOf(c), "is");
      let text = "";
      if (type === "s" && v) text = shared[Number(deepText(v))] ?? "";
      else if (v) text = deepText(v);
      else if (isNode) text = deepText(isNode);
      // 텍스트가 있거나, 빈 셀이라도 스타일(배경색 등)이 있으면 자리·색을 보존
      if (text !== "" || s !== undefined) {
        value.set(`${r},${col}`, { t: text, s });
        if (r > maxRow) maxRow = r;
        if (col > maxCol) maxCol = col;
      }
    }
  }

  // 병합
  const merges: Merge[] = collectDeep(tree, "mergeCell").map((mc) => {
    const ref = attrOf(mc, "ref") ?? "A1:A1";
    const [a, b] = ref.split(":");
    const p = parseRef(a ?? "A1");
    const q = parseRef(b ?? a ?? "A1");
    return { r1: p.row, c1: p.col, r2: q.row, c2: q.col };
  });
  for (const m of merges) {
    if (m.r2 > maxRow) maxRow = m.r2;
    if (m.c2 > maxCol) maxCol = m.c2;
  }

  // dimension 으로 사용 범위 보강(빈 셀 자리 보존)
  const dim = collectDeep(tree, "dimension")[0];
  if (dim) {
    const ref = attrOf(dim, "ref") ?? "";
    const end = ref.split(":")[1];
    if (end) {
      const e = parseRef(end);
      if (e.row > maxRow) maxRow = e.row;
      if (e.col > maxCol) maxCol = e.col;
    }
  }

  const truncated = maxRow + 1 > MAX_ROWS || maxCol + 1 > MAX_COLS;
  return {
    rows: Math.min(maxRow + 1, MAX_ROWS),
    cols: Math.min(maxCol + 1, MAX_COLS),
    value,
    merges,
    colW,
    rowH,
    truncated,
  };
}

function renderGrid(g: Grid, styles: XlsxStyles, images: SheetImage[] = []): string {
  // 가려지는(병합 비-앵커) 셀 집합 + 앵커별 span
  const covered = new Set<string>();
  const span = new Map<string, { cs: number; rs: number }>();
  for (const m of g.merges) {
    span.set(`${m.r1},${m.c1}`, { cs: m.c2 - m.c1 + 1, rs: m.r2 - m.r1 + 1 });
    for (let r = m.r1; r <= m.r2; r++)
      for (let c = m.c1; c <= m.c2; c++) if (!(r === m.r1 && c === m.c1)) covered.add(`${r},${c}`);
  }

  // 이미지 → from 셀 키로 묶는다(원문처럼 그 셀 위에 겹쳐 그린다).
  // 격자 밖이거나 병합으로 가려진 셀이 앵커면 가장 가까운 보이는 위치로 끌어온다.
  const overlays = new Map<string, SheetImage[]>();
  for (const im of images) {
    let { row, col } = im;
    let offX = im.offX;
    let offY = im.offY;
    // 병합으로 가려진 앵커 → 병합 앵커 셀로 이동(사이 셀 폭/높이만큼 오프셋 보정)
    if (covered.has(`${row},${col}`)) {
      const m = g.merges.find((m) => row >= m.r1 && row <= m.r2 && col >= m.c1 && col <= m.c2);
      if (m) {
        for (let c = m.c1; c < col; c++) offX += g.colW.get(c) ?? DEFAULT_COL_PX;
        for (let r = m.r1; r < row; r++) offY += g.rowH.get(r) ?? DEFAULT_ROW_PX;
        row = m.r1;
        col = m.c1;
      }
    }
    // 격자 밖이면 마지막으로 보이는 행/열로 클램프
    row = Math.min(row, g.rows - 1);
    col = Math.min(col, g.cols - 1);
    const key = `${row},${col}`;
    (overlays.get(key) ?? overlays.set(key, []).get(key)!).push({ ...im, row, col, offX, offY });
  }

  // colgroup: 행번호 열 + 각 열 너비(table-layout:fixed 라 폭이 그대로 적용된다)
  let cols = `<col style="width:${ROWHEAD_PX}px" />`;
  for (let c = 0; c < g.cols; c++) cols += `<col style="width:${g.colW.get(c) ?? DEFAULT_COL_PX}px" />`;

  // 열 문자 머리행
  let head = `<tr><th class="xlsx-corner"></th>`;
  for (let c = 0; c < g.cols; c++) head += `<th class="xlsx-colh">${colLetter(c)}</th>`;
  head += `</tr>`;

  let body = "";
  for (let r = 0; r < g.rows; r++) {
    const h = g.rowH.get(r);
    const trStyle = h ? ` style="height:${h}px"` : "";
    let tds = `<th class="xlsx-rowh">${r + 1}</th>`;
    for (let c = 0; c < g.cols; c++) {
      const key = `${r},${c}`;
      if (covered.has(key)) continue; // 병합으로 가려진 셀
      const cell = g.value.get(key);
      const sp = span.get(key);
      const spanAttr = sp ? `${sp.cs > 1 ? ` colspan="${sp.cs}"` : ""}${sp.rs > 1 ? ` rowspan="${sp.rs}"` : ""}` : "";
      const css = cell?.s !== undefined ? styles.css[cell.s] : undefined;
      const ov = overlays.get(key);
      const cls = ov ? ` class="xlsx-imgcell"` : "";
      const styleAttr = css ? ` style="${css}"` : "";
      const imgHtml = ov ? ov.map(imageOverlay).join("") : "";
      tds += `<td${spanAttr}${cls}${styleAttr}>${esc(cell?.t ?? "")}${imgHtml}</td>`;
    }
    body += `<tr${trStyle}>${tds}</tr>`;
  }
  return `<table class="xlsx-grid"><colgroup>${cols}</colgroup><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

// ── 이미지(시트 drawing) ───────────────────────────────────────────────────

interface SheetImage {
  dataUri?: string;
  name: string;
  /** 앵커 from 셀(0-기준). 여기에 이미지를 띄운다. */
  row: number;
  col: number;
  /** from 셀 좌상단 기준 오프셋(px). */
  offX: number;
  offY: number;
  /** 표시 크기(px). */
  w: number;
  h: number;
  /** 이미지가 덮는 마지막 셀(0-기준) — 격자를 이 범위까지 넓혀 원문처럼 보이게. */
  endRow: number;
  endCol: number;
}

const IMG_MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  bmp: "image/bmp", svg: "image/svg+xml",
};

/** path 의 디렉터리 기준으로 상대 target 을 해석. */
function resolvePath(fromPart: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const baseDir = fromPart.split("/").slice(0, -1).join("/");
  const out: string[] = [];
  for (const seg of (baseDir + "/" + target).split("/")) {
    if (seg === "..") out.pop();
    else if (seg !== "." && seg !== "") out.push(seg);
  }
  return out.join("/");
}

/** part 의 _rels 경로(예: xl/worksheets/sheet1.xml → xl/worksheets/_rels/sheet1.xml.rels). */
function relsPathFor(part: string): string {
  const i = part.lastIndexOf("/");
  return `${part.slice(0, i)}/_rels${part.slice(i)}.rels`;
}

/** rels(Id → Target) 읽기. */
function readRels(parts: Record<string, Uint8Array>, relsPath: string): Map<string, string> {
  const m = new Map<string, string>();
  const xml = tryPartToText(parts, relsPath);
  if (!xml) return m;
  for (const rel of collectDeep(parseXml(xml), "Relationship")) {
    const id = attrOf(rel, "Id");
    const t = attrOf(rel, "Target");
    if (id && t) m.set(id, t);
  }
  return m;
}

function dataUriFor(parts: Record<string, Uint8Array>, path: string): string | undefined {
  const buf = parts[path];
  if (!buf) return undefined;
  const ext = (path.split(".").pop() ?? "").toLowerCase();
  const mime = IMG_MIME[ext];
  if (!mime) return undefined; // emf/wmf 등 브라우저 미표시 → 자리표시자
  return `data:${mime};base64,${bytesToBase64(buf)}`;
}

/** 앵커의 from/to 자식(xdr:col/colOff/row/rowOff) → 셀+오프셋. */
function anchorPos(node: XmlNode): { col: number; colOff: number; row: number; rowOff: number } {
  const ch = childrenOf(node);
  const n = (tag: string): number => Number(deepText(findChild(ch, tag) ?? ({} as XmlNode)) || "0");
  return { col: n("xdr:col"), colOff: n("xdr:colOff"), row: n("xdr:row"), rowOff: n("xdr:rowOff") };
}

/**
 * 한 시트에 앵커된 이미지들. twoCellAnchor 는 from~to 셀 범위로, oneCellAnchor 는
 * from + ext(크기)로 위치/크기를 px 환산한다. 격자의 열폭/행높이를 그대로 써서
 * 원문처럼 해당 셀 위에 겹쳐 그린다.
 */
function sheetImages(parts: Record<string, Uint8Array>, sheetPath: string, g: Grid): SheetImage[] {
  const sheetRels = readRels(parts, relsPathFor(sheetPath));
  const drawingTarget = [...sheetRels.values()].find((t) => t.includes("drawings/drawing"));
  if (!drawingTarget) return [];
  const drawingPath = resolvePath(sheetPath, drawingTarget);
  const xml = tryPartToText(parts, drawingPath);
  if (!xml) return [];
  const drawRels = readRels(parts, relsPathFor(drawingPath));
  const tree = parseXml(xml);

  const colPx = (c: number): number => g.colW.get(c) ?? DEFAULT_COL_PX;
  const rowPx = (r: number): number => g.rowH.get(r) ?? DEFAULT_ROW_PX;

  const anchors = [...collectDeep(tree, "xdr:twoCellAnchor"), ...collectDeep(tree, "xdr:oneCellAnchor")];
  const out: SheetImage[] = [];
  for (const anchor of anchors) {
    const blip = findDeep([anchor], "a:blip");
    const embed = blip ? attrOf(blip, "r:embed") : undefined;
    if (!embed) continue;
    const target = drawRels.get(embed);
    if (!target) continue;
    const mediaPath = resolvePath(drawingPath, target);
    const fromNode = findDeep([anchor], "xdr:from");
    if (!fromNode) continue;
    const from = anchorPos(fromNode);
    const offX = emuToPx(from.colOff);
    const offY = emuToPx(from.rowOff);

    let w: number;
    let h: number;
    let endRow: number;
    let endCol: number;
    const toNode = findDeep([anchor], "xdr:to");
    if (toNode) {
      // twoCellAnchor: from~to 사이 셀 폭/높이 합 + 양끝 오프셋차
      const to = anchorPos(toNode);
      let width = -offX + emuToPx(to.colOff);
      for (let c = from.col; c < to.col; c++) width += colPx(c);
      let height = -offY + emuToPx(to.rowOff);
      for (let r = from.row; r < to.row; r++) height += rowPx(r);
      w = Math.max(1, width);
      h = Math.max(1, height);
      endRow = to.row;
      endCol = to.col;
    } else {
      // oneCellAnchor: ext(cx,cy) 가 크기 → 끝 셀은 from 에서 크기만큼 걸어 추정
      const ext = findDeep([anchor], "xdr:ext");
      w = Math.max(1, emuToPx(Number(attrOf(ext ?? ({} as XmlNode), "cx") || "0")));
      h = Math.max(1, emuToPx(Number(attrOf(ext ?? ({} as XmlNode), "cy") || "0")));
      endCol = from.col;
      for (let acc = offX + w, c = from.col; acc > colPx(c) && c < from.col + MAX_COLS; c++, endCol = c) acc -= colPx(c);
      endRow = from.row;
      for (let acc = offY + h, r = from.row; acc > rowPx(r) && r < from.row + MAX_ROWS; r++, endRow = r) acc -= rowPx(r);
    }

    out.push({
      dataUri: dataUriFor(parts, mediaPath),
      name: mediaPath.split("/").pop() ?? "image",
      row: from.row,
      col: from.col,
      offX,
      offY,
      w,
      h,
      endRow,
      endCol,
    });
  }
  return out;
}

/** 한 이미지 → 셀 위에 겹칠 절대배치 마크업(<td> 안에 넣는다). */
function imageOverlay(im: SheetImage): string {
  const pos = `left:${im.offX}px;top:${im.offY}px;width:${im.w}px;height:${im.h}px`;
  if (im.dataUri)
    return `<img class="xlsx-cell-img" style="${pos}" src="${im.dataUri}" alt="${escAttr(im.name)}" title="${escAttr(im.name)}"/>`;
  const ext = (im.name.split(".").pop() ?? "").toUpperCase();
  return `<span class="xlsx-cell-img xlsx-img-ph" style="${pos}" title="${escAttr(im.name)}">🖼 ${esc(ext)}</span>`;
}

export function xlsxToPreviewHtml(bytes: Uint8Array, opts: PreviewOptions = {}): string {
  const parts = readZip(bytes);
  const shared = readSharedStrings(parts);
  const styles = parseXlsxStyles(tryPartToText(parts, "xl/styles.xml"), tryPartToText(parts, "xl/theme/theme1.xml"));

  const body = sheetList(parts)
    .map(({ name, path }) => {
      const g = sheetGrid(tryPartToText(parts, path) ?? "", shared);
      const imgs = sheetImages(parts, path, g);
      // 이미지가 덮는 범위 밖이면 그만큼 격자를 넓혀 원문처럼 이미지 아래 격자가 깔리게 한다.
      for (const im of imgs) {
        g.rows = Math.min(MAX_ROWS, Math.max(g.rows, im.endRow + 1));
        g.cols = Math.min(MAX_COLS, Math.max(g.cols, im.endCol + 1));
      }
      const note = g.truncated ? `<div class="xlsx-note">⚠ 미리보기 상한(${MAX_ROWS}행 × ${MAX_COLS}열)까지만 표시</div>` : "";
      return `<section class="xlsx-sheet"><h2>${esc(name)}</h2><div class="xlsx-scroll">${renderGrid(g, styles, imgs)}</div>${note}</section>`;
    })
    .join("\n");

  const css = `
  body { padding: 24px; }
  .xlsx-sheet { margin: 0 0 28px; }
  .xlsx-sheet h2 { font-size: 15px; margin: 0 0 8px; color:#1f2937; }
  .xlsx-scroll { overflow:auto; max-width:100%; border:1px solid #c9ccd1; border-radius:6px; background:#fff; }
  /* 엑셀 느낌: 고정 레이아웃(열 너비 그대로) + 옅은 격자선. 셀별 인라인 테두리가 이를 덮어쓴다. */
  .xlsx-grid { border-collapse: collapse; table-layout: fixed; font-size: 11pt; color:#1a1a1a; }
  .xlsx-grid th, .xlsx-grid td { border:1px solid #e1e3e8; padding:2px 6px; overflow:hidden;
    white-space:nowrap; text-overflow:ellipsis; vertical-align:middle; }
  .xlsx-colh, .xlsx-rowh, .xlsx-corner { background:#f3f4f6; color:#6b7280; font-weight:600;
    text-align:center; font-size:11px; }
  .xlsx-note { font-size:11.5px; color:#9aa0a6; margin-top:6px; }
  /* 셀 위에 겹쳐 그리는 이미지(원문 그대로): 앵커 셀을 기준점으로 절대배치, 이웃 셀로 넘쳐도 보이게. */
  .xlsx-grid td.xlsx-imgcell { position:relative; overflow:visible; }
  .xlsx-cell-img { position:absolute; z-index:3; object-fit:fill; }
  .xlsx-img-ph { display:grid; place-items:center; background:#f3f4f6; border:1px solid #d6d9dd;
    border-radius:4px; color:#9aa0a6; font-size:12px; box-sizing:border-box; }
  `;
  // 스프레드시트는 페이지 카드(고정 폭)에 가두지 않고 전체 폭 + 가로 스크롤로 보여준다.
  return toPreviewHtml(`<div class="xlsx-wrap">${body}</div>`, { ...opts, css: (opts.css ?? "") + css });
}

export const xlsxAdapter: FormatAdapter = {
  id: "xlsx",
  label: "Excel 스프레드시트 (.xlsx)",
  supportsRoundTrip: true,
  detect(parts) {
    return Object.keys(parts).some((p) => p.startsWith("xl/"));
  },
  encode(bytes) {
    return encodeXlsxToHtml(bytes);
  },
  decode(html: string, manifest: Manifest) {
    return decodeHtmlToXlsx(html, manifest);
  },
  toPreviewHtml(bytes, opts) {
    return xlsxToPreviewHtml(bytes, (opts ?? {}) as PreviewOptions);
  },
};

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escAttr(s: string): string {
  return esc(s).replace(/"/g, "&quot;");
}
