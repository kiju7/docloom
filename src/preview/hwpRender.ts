/**
 * HWP 5.0 리치 미리보기 렌더러 — 레코드 트리 재귀 방식(원본 충실도).
 *
 * HWP 본문 레코드는 level 로 트리를 이룬다(문단>컨트롤>표>셀>문단…). 평면 처리하면
 * 중첩 표·셀 안 그림이 깨지므로, level 로 forest 를 만들어 재귀 렌더한다.
 *   PARA_HEADER → 문단(PARA_TEXT+CHAR_SHAPE 로 런별 글자모양, PARA_SHAPE 정렬)
 *   CTRL_HEADER "tbl " → 표(TABLE cols + LIST_HEADER 셀들, 셀 내용은 재귀)
 *   CTRL_HEADER "gso "/그림 → SHAPE_PICTURE → BinData 이미지
 *   CTRL_HEADER "head"/"foot" → 머릿말/꼬리말
 * 서식: DocInfo(parseHwpStyles)의 CHAR_SHAPE(크기/색/글꼴)·PARA_SHAPE(정렬)·BORDER_FILL(셀).
 * 용지: PAGE_DEF → docx 페이지 엔진(toPagedHtml).
 */
import { readCfb } from "../core/cfb.js";
import {
  type HwpRecord,
  parseFileHeader,
  hwpInflate,
  parseRecords,
  readParaHeader,
  wcharsToString,
  HWPTAG_PARA_HEADER,
  HWPTAG_PARA_TEXT,
  HWPTAG_PARA_CHAR_SHAPE,
  HWPTAG_CTRL_HEADER,
  HWPTAG_LIST_HEADER,
} from "../hwp/record.js";
import { buildPaletteFromHwp } from "../hwp/docinfo.js";
import { parseHwpStyles, parseCharShapeRuns, type HwpStyles, type HwpCharShape } from "../hwp/styles.js";
import { bytesToBase64 } from "../core/base64.js";
import type { Palette } from "../palette/palette.js";
import { classFromStyleKey, htmlTagFromStyleKey, styleKeyFromDocxId } from "../palette/palette.js";
import type { RenderResult, SectionProps } from "./render.js";

const HWPTAG_PAGE_DEF = 0x10 + 57; // 73
const HWPTAG_TABLE = 0x10 + 61; // 77
const HWPTAG_SHAPE_PICTURE = 0x10 + 69; // 85
const HU = 96 / 7200;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

interface Node {
  rec: HwpRecord;
  children: Node[];
}
function buildForest(records: HwpRecord[]): Node[] {
  const roots: Node[] = [];
  const stack: Node[] = [];
  for (const rec of records) {
    const node: Node = { rec, children: [] };
    while (stack.length && stack[stack.length - 1]!.rec.level >= rec.level) stack.pop();
    if (stack.length) stack[stack.length - 1]!.children.push(node);
    else roots.push(node);
    stack.push(node);
  }
  return roots;
}
function child(node: Node, tag: number): Node | undefined {
  return node.children.find((c) => c.rec.tag === tag);
}
function deepFind(node: Node, tag: number): Node | undefined {
  for (const c of node.children) {
    if (c.rec.tag === tag) return c;
    const d = deepFind(c, tag);
    if (d) return d;
  }
  return undefined;
}

interface Ctx {
  palette: Palette;
  styles: HwpStyles;
  images: string[];
  imgCursor: { i: number };
}

/** hwp 바이트 → 페이지 렌더용 RenderResult. */
export function renderHwpResult(hwp: Uint8Array): { result: RenderResult; palette: Palette } {
  const cfb = readCfb(hwp);
  const fh = parseFileHeader(cfb.streams["FileHeader"] ?? new Uint8Array(0));
  const inflate = (b: Uint8Array | undefined) => (b ? (fh.compressed ? hwpInflate(b) : b) : new Uint8Array(0));
  const docInfo = inflate(cfb.streams["DocInfo"]);
  const palette = buildPaletteFromHwp(docInfo);
  const ctx: Ctx = { palette, styles: parseHwpStyles(docInfo), images: collectImages(cfb.streams), imgCursor: { i: 0 } };

  const sections = Object.keys(cfb.streams)
    .filter((p) => /^BodyText\/Section\d+$/.test(p))
    .sort();

  const bodies: string[] = [];
  let section: SectionProps | undefined;
  let header = "";
  let footer = "";

  for (const path of sections) {
    const records = parseRecords(inflate(cfb.streams[path]));
    if (!section) section = pageFromRecords(records);
    const forest = buildForest(records);
    const hf = collectHeaderFooter(forest, ctx);
    if (!header && hf.header) header = hf.header;
    if (!footer && hf.footer) footer = hf.footer;
    bodies.push(forest.filter((n) => n.rec.tag === HWPTAG_PARA_HEADER).map((n) => renderParagraph(n, ctx)).join("\n"));
  }

  return { result: { body: bodies.join("\n"), header, footer, section: section ?? defaultSection() }, palette };
}

// ── 페이지 ──────────────────────────────────────────────────────────────────

const SECTION_EXTRA = { orient: "portrait" as const, gutterPx: 0, titlePg: false, headerRefs: {}, footerRefs: {} };
function defaultSection(): SectionProps {
  return {
    page: { wPx: 794, hPx: 1123, topPx: 76, rightPx: 113, bottomPx: 57, leftPx: 113, headerPx: 57, footerPx: 57 },
    cols: { num: 1, space: 10, sep: false },
    ...SECTION_EXTRA,
  };
}
function pageFromRecords(records: HwpRecord[]): SectionProps {
  const pd = records.find((r) => r.tag === HWPTAG_PAGE_DEF);
  if (!pd || pd.data.length < 24) return defaultSection();
  const dv = new DataView(pd.data.buffer, pd.data.byteOffset, pd.data.byteLength);
  const u = (o: number) => Math.round(dv.getUint32(o, true) * HU);
  return {
    page: {
      wPx: u(0),
      hPx: u(4),
      leftPx: u(8),
      rightPx: u(12),
      topPx: u(16),
      bottomPx: u(20),
      headerPx: pd.data.length >= 28 ? u(24) : 57,
      footerPx: pd.data.length >= 32 ? u(28) : 57,
    },
    cols: { num: 1, space: 10, sep: false },
    ...SECTION_EXTRA,
  };
}

// ── 머릿말/꼬리말 ────────────────────────────────────────────────────────────

function collectHeaderFooter(forest: Node[], ctx: Ctx): { header: string; footer: string } {
  let header = "";
  let footer = "";
  const visit = (node: Node) => {
    if (node.rec.tag === HWPTAG_CTRL_HEADER) {
      const id = ctrlId(node.rec.data);
      if (id === "head" || id === "foot") {
        const html = renderCellParas(node, ctx);
        if (id === "head" && !header) header = html;
        if (id === "foot" && !footer) footer = html;
        return; // 본문에선 제외
      }
    }
    for (const c of node.children) visit(c);
  };
  for (const n of forest) visit(n);
  return { header, footer };
}

/** 컨트롤(머릿말/꼬리말 등) 하위의 문단들을 렌더. */
function renderCellParas(ctrl: Node, ctx: Ctx): string {
  return ctrl.children
    .filter((c) => c.rec.tag === HWPTAG_PARA_HEADER)
    .map((p) => renderParagraph(p, ctx))
    .join("");
}

// ── 문단 ────────────────────────────────────────────────────────────────────

function renderParagraph(ph: Node, ctx: Ctx): string {
  const hf = readParaHeader(ph.rec.data);
  const dv = new DataView(ph.rec.data.buffer, ph.rec.data.byteOffset, ph.rec.data.byteLength);
  const paraShapeId = ph.rec.data.length >= 10 ? dv.getUint16(8, true) : 0;
  const styleKey = styleKeyFromDocxId(ctx.palette, String(hf.styleId));
  const tag = htmlTagFromStyleKey(ctx.palette, styleKey);
  const cls = classFromStyleKey(styleKey);
  const align = ctx.styles.paraShapes[paraShapeId];
  const style = align ? ` style="text-align:${align}"` : "";

  const textNode = child(ph, HWPTAG_PARA_TEXT);
  const csNode = child(ph, HWPTAG_PARA_CHAR_SHAPE);
  const inline = textNode ? renderRuns(textNode.rec.data, csNode?.rec.data, ctx) : "";

  const blocks: string[] = [];
  for (const c of ph.children) {
    if (c.rec.tag !== HWPTAG_CTRL_HEADER) continue;
    const id = ctrlId(c.rec.data);
    if (id === "tbl ") blocks.push(renderTable(c, ctx));
    else if (id === "head" || id === "foot") continue;
    else if (deepFind(c, HWPTAG_SHAPE_PICTURE)) {
      const uri = ctx.images[ctx.imgCursor.i++];
      if (uri) blocks.push(`<img class="docloom-img" src="${uri}" alt="그림"/>`);
    }
  }

  const para = inline.trim() || blocks.length === 0 ? `<${tag} class="${cls}"${style}>${inline || "<br/>"}</${tag}>` : "";
  return [para, ...blocks].filter(Boolean).join("\n");
}

function renderRuns(textData: Uint8Array, csData: Uint8Array | undefined, ctx: Ctx): string {
  const raw = wcharsToString(textData);
  const runs = csData ? parseCharShapeRuns(csData) : [];
  if (runs.length === 0) runs.push({ pos: 0, shapeId: 0 });
  let html = "";
  for (let k = 0; k < runs.length; k++) {
    const start = runs[k]!.pos;
    const end = k + 1 < runs.length ? runs[k + 1]!.pos : raw.length;
    const seg = cleanSeg(raw.slice(start, end));
    if (!seg) continue;
    html += styleSeg(esc(seg), ctx.styles.charShapes[runs[k]!.shapeId], ctx.styles.faces);
  }
  return html;
}

function cleanSeg(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    if (c >= 32) out += ch;
    else if (c === 9) out += "  ";
  }
  return out;
}

function styleSeg(html: string, cs: HwpCharShape | undefined, faces: string[]): string {
  let t = html;
  if (cs?.bold) t = `<strong>${t}</strong>`;
  if (cs?.italic) t = `<em>${t}</em>`;
  if (cs?.underline) t = `<u>${t}</u>`;
  if (cs?.strike) t = `<s>${t}</s>`;
  const parts: string[] = [];
  if (cs?.sizePt) parts.push(`font-size:${cs.sizePt}pt`);
  if (cs?.color) parts.push(`color:${cs.color}`);
  const face = cs ? faces[cs.faceId] : undefined;
  if (face) parts.push(`font-family:'${face.replace(/'/g, "")}',sans-serif`);
  return parts.length ? `<span style="${parts.join(";")}">${t}</span>` : t;
}

// ── 표 ──────────────────────────────────────────────────────────────────────

function ctrlId(data: Uint8Array): string {
  if (data.length < 4) return "";
  return String.fromCharCode(data[3]!, data[2]!, data[1]!, data[0]!);
}

function renderTable(ctrl: Node, ctx: Ctx): string {
  const tableNode = child(ctrl, HWPTAG_TABLE);
  let cols = 1;
  if (tableNode && tableNode.rec.data.length >= 8) {
    cols = Math.max(1, new DataView(tableNode.rec.data.buffer, tableNode.rec.data.byteOffset, tableNode.rec.data.byteLength).getUint16(6, true));
  }

  // 셀 그룹: ctrl 자식 중 LIST_HEADER 가 셀 시작, 이후 PARA_HEADER 들이 셀 내용
  interface Cell {
    paras: Node[];
    list: Uint8Array;
  }
  const cells: Cell[] = [];
  let cur: Cell | undefined;
  for (const c of ctrl.children) {
    if (c.rec.tag === HWPTAG_LIST_HEADER) {
      cur = { paras: [], list: c.rec.data };
      cells.push(cur);
      // 셀 문단이 LIST 의 자식으로 들어오는 경우도 수용
      for (const cc of c.children) if (cc.rec.tag === HWPTAG_PARA_HEADER) cur.paras.push(cc);
    } else if (c.rec.tag === HWPTAG_PARA_HEADER && cur) {
      cur.paras.push(c);
    }
  }
  if (cells.length === 0) return "";

  // colSpan 합으로 행 분할(셀@10 colSpan, @12 rowSpan 근사; 점유 추적)
  const rows: string[][] = [[]];
  let acc = 0;
  for (const cell of cells) {
    const colSpan = span(cell.list, 10, cols);
    const rowSpan = span(cell.list, 12, 1000);
    const inner = cell.paras.map((p) => renderParagraph(p, ctx)).join("") || "<br/>";
    const td = `<td${colSpan > 1 ? ` colspan="${colSpan}"` : ""}${rowSpan > 1 ? ` rowspan="${rowSpan}"` : ""}${cellStyle(cell.list, ctx) ? ` style="${cellStyle(cell.list, ctx)}"` : ""}>${inner}</td>`;
    rows[rows.length - 1]!.push(td);
    acc += colSpan;
    if (acc >= cols) {
      acc = 0;
      rows.push([]);
    }
  }
  const body = rows.filter((r) => r.length).map((r) => `<tr>${r.join("")}</tr>`).join("");
  return `<table class="docloom-table hwp-table"><tbody>${body}</tbody></table>`;
}

function span(list: Uint8Array, off: number, max: number): number {
  if (list.length < off + 2) return 1;
  const n = new DataView(list.buffer, list.byteOffset, list.byteLength).getUint16(off, true);
  return n >= 1 && n <= max ? n : 1;
}

function cellStyle(list: Uint8Array, ctx: Ctx): string {
  let bfId = 0;
  if (list.length >= 32) bfId = new DataView(list.buffer, list.byteOffset, list.byteLength).getUint16(30, true);
  const bf = ctx.styles.borderFills[bfId];
  if (!bf) return "";
  const parts: string[] = [];
  (["left", "right", "top", "bottom"] as const).forEach((name) => {
    const b = bf[name];
    parts.push(`border-${name}:${b.width > 0 ? `${b.width}px solid ${b.color}` : "none"}`);
  });
  if (bf.bg && bf.bg !== "#ffffff" && bf.bg !== "#000000") parts.push(`background:${bf.bg}`);
  return parts.join(";");
}

// ── 그림 ────────────────────────────────────────────────────────────────────

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
};
function collectImages(streams: Record<string, Uint8Array>): string[] {
  return Object.keys(streams)
    .filter((p) => /^BinData\/BIN[0-9A-Fa-f]+\.\w+$/.test(p))
    .sort()
    .map((p) => {
      const ext = p.split(".").pop()?.toLowerCase() ?? "";
      const mime = MIME[ext];
      return mime ? `data:${mime};base64,${bytesToBase64(streams[p]!)}` : "";
    })
    .filter(Boolean);
}

/**
 * HWP 바이트의 `BinData/` 임베디드 그림을 문서순(BIN0001…) data URI 배열로 추출.
 * rhwp 리치 미리보기가 floating(페이지앵커) 그림을 노출하지 못할 때의 보강용.
 */
export function extractHwpBinImages(hwp: Uint8Array): string[] {
  try {
    return collectImages(readCfb(hwp).streams);
  } catch {
    return [];
  }
}
