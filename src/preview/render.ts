/**
 * 미리보기 전용 리치 렌더러 (docx → 보기용 HTML).
 *
 * 왕복용 encode/decode 와 달리, 여기서는 "원본처럼 보이기"가 목표라 인라인 스타일·
 * 이미지·머리말/꼬리말·목록 마커·페이지나눔 등을 자유롭게 쓴다(이 HTML 은 decode
 * 대상이 아니므로 제약 팔레트 규칙을 따르지 않아도 된다).
 *
 * 지원: 문단(스타일 class + 직접서식), 런(굵게/기울임/밑줄/색/크기), 줄바꿈/탭,
 *       페이지나눔, 이미지(data URI), 표, 머리말/꼬리말, 글머리기호/번호(부분).
 * 한계: 페이지번호(PAGE 필드)는 리플로우 HTML 에서 실시간 계산 불가 — 캐시값만 표시.
 *       다단/세로병합/도형은 부분 지원.
 */
import {
  parseXml,
  tagOf,
  childrenOf,
  textOf,
  attrOf,
  findChild,
  findChildren,
  findBody,
  splitBodyChildren,
  type XmlNode,
} from "../docx/ooxml.js";
import { parseSectionProps, type SectionProps, type PageGeom } from "../docx/section.js";
import { bytesToBase64 } from "../core/base64.js";
import {
  type Palette,
  styleKeyFromDocxId,
  classFromStyleKey,
  htmlTagFromStyleKey,
} from "../palette/palette.js";

export type { PageGeom, SectionProps } from "../docx/section.js";

/** auto 줄간격(line/240=명목 배수)을 CSS line-height 로 환산할 때 곱하는 폰트 단일행 비율(~1.15).
 *  truth PDF(Word+맑은 고딕, ~1.7)가 아니라 docx 명목값에 충실(한컴/일반 뷰어 기준). */
const LINE_AUTO_FACTOR = 1.15;

interface Ctx {
  palette: Palette;
  rels: Map<string, string>; // rId → target (word/ 기준 상대경로)
  parts: Record<string, Uint8Array>;
  numbering: Numbering;
  counters: Map<string, number[]>; // numId → 레벨별 카운터
  styleNum: Map<string, { numId: string; ilvl: number }>; // styleId → 스타일에 박힌 numPr
  tableStyleBorders: Map<string, Borders>; // 표 styleId → tblBorders
}

export interface RenderResult {
  /** 본문 블록 HTML (머리말/꼬리말 제외). */
  body: string;
  /** 머리말 HTML (없으면 ""). */
  header: string;
  /** 꼬리말 HTML (없으면 ""). */
  footer: string;
  /** 섹션 속성(용지·여백·방향·다단·테두리). 페이지 방식 레이아웃에 사용. */
  section: SectionProps;
}

export function renderPreviewBody(parts: Record<string, Uint8Array>, palette: Palette): RenderResult {
  const dec = new TextDecoder();
  const ctx: Ctx = {
    palette,
    rels: buildRels(parts, "word/_rels/document.xml.rels", dec),
    parts,
    numbering: buildNumbering(parts, dec),
    counters: new Map(),
    styleNum: buildStyleNum(parts, dec),
    tableStyleBorders: buildTableStyleBorders(parts, dec),
  };

  const doc = parseXml(dec.decode(parts["word/document.xml"]!));
  const body = findBody(doc);
  const { content, sectPr } = splitBodyChildren(body);

  return {
    body: renderNodes(content, ctx),
    header: renderHeaderFooter(parts, "header", ctx, dec),
    footer: renderHeaderFooter(parts, "footer", ctx, dec),
    section: parseSectionProps(sectPr),
  };
}

// ── 머리말/꼬리말 ────────────────────────────────────────────────────────

function renderHeaderFooter(
  parts: Record<string, Uint8Array>,
  kind: "header" | "footer",
  ctx: Ctx,
  dec: InstanceType<typeof TextDecoder>,
): string {
  // 보통 header1.xml / footer1.xml. 여러 개면 첫 번째만(기본 섹션) 사용.
  const path = `word/${kind}1.xml`;
  const buf = parts[path];
  if (!buf) return "";
  const root = parseXml(dec.decode(buf));
  const rootTag = kind === "header" ? "w:hdr" : "w:ftr";
  const node = root.find((n) => tagOf(n) === rootTag);
  if (!node) return "";
  // 머리말/꼬리말 전용 rels (이미지 등)
  const subCtx: Ctx = { ...ctx, rels: buildRels(parts, `word/_rels/${kind}1.xml.rels`, dec) };
  return renderNodes(childrenOf(node), subCtx);
}

// ── 블록 ────────────────────────────────────────────────────────────────

function renderNodes(nodes: XmlNode[], ctx: Ctx): string {
  let out = "";
  for (const node of nodes) {
    const tag = tagOf(node);
    if (tag === "w:p") out += renderParagraph(node, ctx);
    else if (tag === "w:tbl") out += renderTable(node, ctx);
    else if (tag === "w:sdt") out += renderNodes(sdtContentChildren(node), ctx); // 목차(TOC) 등 구조화 문서 태그 펼치기
    // 그 외(sectPr 등)는 무시
  }
  return out;
}

/** w:sdt 의 w:sdtContent 자식들(목차·콘텐츠 컨트롤 내용). 없으면 빈 배열. */
function sdtContentChildren(sdt: XmlNode): XmlNode[] {
  const content = findChild(childrenOf(sdt), "w:sdtContent");
  return content ? childrenOf(content) : [];
}

function renderParagraph(p: XmlNode, ctx: Ctx): string {
  const kids = childrenOf(p);
  const pPr = findChild(kids, "w:pPr");
  const styleId = pPr ? attrOf(findChild(childrenOf(pPr), "w:pStyle") ?? {}, "w:val") : undefined;
  const styleKey = styleKeyFromDocxId(ctx.palette, styleId);
  const tag = htmlTagFromStyleKey(ctx.palette, styleKey);

  const listLvl = resolveListLevel(pPr, styleId, ctx);
  const style = paragraphInlineStyle(pPr, listLvl?.level);
  const marker = listLvl ? listMarker(listLvl, ctx) : "";
  const inner = renderRuns(p, ctx);

  const cls = classFromStyleKey(styleKey);
  const styleAttr = style ? ` style="${style}"` : "";
  return `<${tag} class="${cls}"${styleAttr}>${marker}${inner || "&#8203;"}</${tag}>`;
}

/** 문단 직접서식 → 인라인 CSS (정렬·들여쓰기·간격·문단 하단 테두리).
 *  목록 문단인데 직접 w:ind 가 없으면 번호 레벨의 들여쓰기(내어쓰기 포함)를 대신 적용한다. */
function paragraphInlineStyle(pPr: XmlNode | undefined, listLevel?: NumLevel): string {
  if (!pPr) return listLevel ? levelIndentCss(listLevel) : "";
  const kids = childrenOf(pPr);
  const d: string[] = [];

  const jc = attrOf(findChild(kids, "w:jc") ?? {}, "w:val");
  const align = mapAlign(jc);
  if (align) d.push(`text-align:${align}`);

  const ind = findChild(kids, "w:ind");
  if (ind) {
    const left = Number(attrOf(ind, "w:left") ?? attrOf(ind, "w:start"));
    if (Number.isFinite(left)) d.push(`margin-left:${round(left / 20)}pt`);
    const right = Number(attrOf(ind, "w:right") ?? attrOf(ind, "w:end"));
    if (Number.isFinite(right)) d.push(`margin-right:${round(right / 20)}pt`);
    const firstLine = Number(attrOf(ind, "w:firstLine"));
    const hanging = Number(attrOf(ind, "w:hanging"));
    if (Number.isFinite(hanging)) d.push(`text-indent:${round(-hanging / 20)}pt`);
    else if (Number.isFinite(firstLine)) d.push(`text-indent:${round(firstLine / 20)}pt`);
  } else if (listLevel) {
    const li = levelIndentCss(listLevel);
    if (li) d.push(li);
  }

  const spacing = findChild(kids, "w:spacing");
  if (spacing) {
    const before = Number(attrOf(spacing, "w:before"));
    const after = Number(attrOf(spacing, "w:after"));
    if (Number.isFinite(before)) d.push(`margin-top:${round(before / 20)}pt`);
    if (Number.isFinite(after)) d.push(`margin-bottom:${round(after / 20)}pt`);
    const line = Number(attrOf(spacing, "w:line"));
    const lineRule = attrOf(spacing, "w:lineRule");
    if (Number.isFinite(line)) {
      // auto(기본): 240=1줄. CSS line-height 배수로 환산 시 폰트 자연 줄높이 보정(~1.7).
      // atLeast/exact: twips → pt 절대 높이.
      if (lineRule === "exact" || lineRule === "atLeast") d.push(`line-height:${round(line / 20)}pt`);
      else d.push(`line-height:${round((line / 240) * LINE_AUTO_FACTOR)}`);
    }
  }

  const pBdr = findChild(kids, "w:pBdr");
  if (pBdr) {
    const bottom = findChild(childrenOf(pBdr), "w:bottom");
    if (bottom) {
      const color = attrOf(bottom, "w:color");
      const c = color && color.toLowerCase() !== "auto" ? `#${color}` : "#000";
      d.push(`border-bottom:1px solid ${c}`, "padding-bottom:4pt");
    }
  }
  return d.join(";");
}

// ── 런(인라인) ──────────────────────────────────────────────────────────

function renderRuns(container: XmlNode, ctx: Ctx): string {
  let out = "";
  for (const child of childrenOf(container)) {
    const tag = tagOf(child);
    if (tag === "w:r") out += renderRun(child, ctx);
    else if (tag === "w:hyperlink") {
      // 외부 링크(r:id)는 파란 밑줄. 내부 앵커(목차 등)는 본문색 유지.
      const inner = renderRuns(child, ctx);
      out += attrOf(child, "r:id")
        ? `<span style="color:#0563c1;text-decoration:underline">${inner}</span>`
        : inner;
    }
    else if (tag === "w:sdt") out += renderRuns({ "w:sdtContent": sdtContentChildren(child) }, ctx); // 인라인 sdt 펼치기
    else if (tag === "w:fldSimple") out += renderFldSimple(child, ctx);
  }
  return out;
}

/** w:fldSimple — PAGE/NUMPAGES 는 페이지네이터가 채울 자리표시자로, 그 외는 내부 런 렌더. */
function renderFldSimple(node: XmlNode, ctx: Ctx): string {
  const instr = (attrOf(node, "w:instr") ?? "").toUpperCase();
  if (/\bNUMPAGES\b/.test(instr)) return '<span class="page-number" data-field="NUMPAGES">1</span>';
  if (/\bPAGE\b/.test(instr)) return '<span class="page-number" data-field="PAGE">1</span>';
  return renderRuns(node, ctx);
}

function renderRun(r: XmlNode, ctx: Ctx): string {
  const kids = childrenOf(r);
  const rPr = findChild(kids, "w:rPr");
  const style = runInlineStyle(rPr);

  let content = "";
  for (const child of kids) {
    const tag = tagOf(child);
    if (tag === "w:t") {
      for (const tc of childrenOf(child)) {
        const tx = textOf(tc);
        if (tx !== undefined) content += escapeHtml(tx);
      }
    } else if (tag === "w:br") {
      content += attrOf(child, "w:type") === "page" ? '<span class="docloom-pagebreak"></span>' : "<br/>";
    } else if (tag === "w:cr") {
      content += "<br/>";
    } else if (tag === "w:tab") {
      content += '<span class="docloom-tab"></span>';
    } else if (tag === "w:drawing" || tag === "w:pict") {
      content += renderImage(child, ctx);
    }
  }
  if (content === "") return "";
  return style ? `<span style="${style}">${content}</span>` : content;
}

/** 런 직접서식 → 인라인 CSS (굵게/기울임/밑줄/취소선/색/크기). */
function runInlineStyle(rPr: XmlNode | undefined): string {
  if (!rPr) return "";
  const kids = childrenOf(rPr);
  const d: string[] = [];
  if (isOn(findChild(kids, "w:b"))) d.push("font-weight:700");
  if (isOn(findChild(kids, "w:i"))) d.push("font-style:italic");
  const u = findChild(kids, "w:u");
  if (u && (attrOf(u, "w:val") ?? "single").toLowerCase() !== "none") d.push("text-decoration:underline");
  if (isOn(findChild(kids, "w:strike"))) d.push("text-decoration:line-through");
  const color = attrOf(findChild(kids, "w:color") ?? {}, "w:val");
  if (color && color.toLowerCase() !== "auto") d.push(`color:#${color}`);
  const sz = Number(attrOf(findChild(kids, "w:sz") ?? {}, "w:val"));
  if (Number.isFinite(sz)) d.push(`font-size:${round(sz / 2)}pt`);
  const high = attrOf(findChild(kids, "w:highlight") ?? {}, "w:val");
  if (high && high !== "none") d.push(`background-color:${high}`);
  return d.join(";");
}

// ── 이미지 ────────────────────────────────────────────────────────────────

function renderImage(node: XmlNode, ctx: Ctx): string {
  const embed = findBlipEmbed(node);
  if (!embed) return "";
  const target = ctx.rels.get(embed);
  if (!target) return "";
  const dataUri = mediaDataUri(ctx.parts, target);
  if (!dataUri) return "";
  return `<img class="docloom-img" src="${dataUri}" alt=""/>`;
}

/** w:drawing/w:pict 하위 어디든 있는 a:blip@r:embed (또는 v:imagedata@r:id) 찾기. */
function findBlipEmbed(node: XmlNode): string | undefined {
  for (const c of childrenOf(node)) {
    const t = tagOf(c);
    if (t === "a:blip") {
      const e = attrOf(c, "r:embed") ?? attrOf(c, "r:link");
      if (e) return e;
    }
    if (t === "v:imagedata") {
      const e = attrOf(c, "r:id");
      if (e) return e;
    }
    const deep = findBlipEmbed(c);
    if (deep) return deep;
  }
  return undefined;
}

function mediaDataUri(parts: Record<string, Uint8Array>, target: string): string | undefined {
  const path = target.startsWith("word/") ? target : `word/${target.replace(/^\.\//, "")}`;
  const buf = parts[path] ?? parts[target];
  if (!buf) return undefined;
  const ext = (path.split(".").pop() ?? "").toLowerCase();
  const mime =
    ext === "png" ? "image/png" :
    ext === "jpg" || ext === "jpeg" ? "image/jpeg" :
    ext === "gif" ? "image/gif" :
    ext === "bmp" ? "image/bmp" :
    ext === "svg" ? "image/svg+xml" :
    ext === "emf" || ext === "wmf" ? "" : // 브라우저 미지원 → 생략
    "application/octet-stream";
  if (!mime) return undefined;
  return `data:${mime};base64,${bytesToBase64(buf)}`;
}

// ── 표 ────────────────────────────────────────────────────────────────────

interface Side {
  val: string; // single, double, nil, dashed, thickThinSmallGap …
  sz: number; // 1/8 pt
  color?: string; // 16진수 or "auto"
}
type BorderSide = "top" | "left" | "bottom" | "right" | "insideH" | "insideV";
type Borders = Partial<Record<BorderSide, Side>>;

/** w:tblBorders/w:tcBorders 노드 → Borders. */
function readBorders(node: XmlNode | undefined): Borders | undefined {
  if (!node) return undefined;
  const out: Borders = {};
  for (const side of ["top", "left", "bottom", "right", "insideH", "insideV"] as BorderSide[]) {
    const s = findChild(childrenOf(node), `w:${side}`);
    if (!s) continue;
    out[side] = {
      val: attrOf(s, "w:val") ?? "single",
      sz: Number(attrOf(s, "w:sz") ?? "4"),
      color: attrOf(s, "w:color"),
    };
  }
  return Object.keys(out).length ? out : undefined;
}

/** Side → CSS border 값. nil/none 이면 "none". */
function sideToCss(s: Side | undefined): string {
  if (!s || s.val === "nil" || s.val === "none") return "none";
  const w = Number.isFinite(s.sz) && s.sz > 0 ? s.sz / 8 : 0.5; // sz: 1/8 pt
  const color = s.color && s.color.toLowerCase() !== "auto" ? `#${s.color}` : "#000";
  // double·thickThin·thinThick 계열은 이중선, dashed/dotted 는 그대로, 그 외 single.
  const style = /double|thick|thin/i.test(s.val)
    ? "double"
    : s.val === "dashed"
      ? "dashed"
      : s.val === "dotted"
        ? "dotted"
        : "solid";
  return `${round(w)}pt ${style} ${color}`;
}

/** styles.xml 의 표 스타일별 tblBorders 맵. */
function buildTableStyleBorders(
  parts: Record<string, Uint8Array>,
  dec: InstanceType<typeof TextDecoder>,
): Map<string, Borders> {
  const map = new Map<string, Borders>();
  const buf = parts["word/styles.xml"];
  if (!buf) return map;
  const tree = parseXml(dec.decode(buf));
  const root = tree.find((n) => tagOf(n) === "w:styles");
  if (!root) return map;
  for (const st of findChildren(childrenOf(root), "w:style")) {
    if (attrOf(st, "w:type") !== "table") continue;
    const styleId = attrOf(st, "w:styleId");
    if (!styleId) continue;
    const tblPr = findChild(childrenOf(st), "w:tblPr");
    const b = tblPr ? readBorders(findChild(childrenOf(tblPr), "w:tblBorders")) : undefined;
    if (b) map.set(styleId, b);
  }
  return map;
}

interface RenderedCell {
  html: string;
  colspan: number;
  style: string; // CSS 선언 묶음 (배경·세로정렬·테두리)
  rows: number; // vMerge rowspan (1 = 병합 없음)
}

function renderTable(tbl: XmlNode, ctx: Ctx): string {
  // vMerge(세로 병합): restart 셀이 같은 grid 열에서 이어지는 continue 셀 수만큼 rowspan.
  // continue 셀은 출력하지 않는다. grid 열 위치는 gridSpan(colspan)을 더해 추적한다.
  const grid: (RenderedCell | undefined)[] = []; // 열 index → 현재 열린 restart 셀
  const rowCells: RenderedCell[][] = [];

  // 표 테두리 소스: 직접 tblBorders > 표 스타일 tblBorders. 하나라도 있으면 셀마다
  // 실제 테두리를 인라인으로 입혀(회색 기본 테두리 대신) 원본 색·굵기·변별을 살린다.
  const tblPr = findChild(childrenOf(tbl), "w:tblPr");
  const tblPrKids = tblPr ? childrenOf(tblPr) : [];
  const styleId = attrOf(findChild(tblPrKids, "w:tblStyle") ?? {}, "w:val");
  const directBorders = readBorders(findChild(tblPrKids, "w:tblBorders"));
  const styleBorders = styleId ? ctx.tableStyleBorders.get(styleId) : undefined;
  const tableBorders: Borders | undefined =
    directBorders || styleBorders ? { ...(styleBorders ?? {}), ...(directBorders ?? {}) } : undefined;

  const trs = findChildren(childrenOf(tbl), "w:tr");
  const numRows = trs.length;
  const gridDef = findChild(childrenOf(tbl), "w:tblGrid"); // tblGrid 는 tbl 직속
  const numCols = gridDef ? findChildren(childrenOf(gridDef), "w:gridCol").length : 0;

  let hasAnyBorderSource = !!tableBorders;

  trs.forEach((tr, rowIndex) => {
    const cellsInRow: RenderedCell[] = [];
    let col = 0;
    for (const tc of findChildren(childrenOf(tr), "w:tc")) {
      const tcKids = childrenOf(tc);
      const tcPr = findChild(tcKids, "w:tcPr");
      let colspan = 1;
      const decls: string[] = [];
      let vMerge: string | undefined;
      let tcBorders: Borders | undefined;
      if (tcPr) {
        const p = childrenOf(tcPr);
        const gs = Number(attrOf(findChild(p, "w:gridSpan") ?? {}, "w:val"));
        if (Number.isFinite(gs) && gs > 1) colspan = gs;
        const fill = attrOf(findChild(p, "w:shd") ?? {}, "w:fill");
        if (fill && fill.toLowerCase() !== "auto") decls.push(`background-color:#${fill}`);
        const vAlign = attrOf(findChild(p, "w:vAlign") ?? {}, "w:val");
        const va = vAlign === "center" ? "middle" : vAlign === "bottom" ? "bottom" : vAlign === "top" ? "top" : undefined;
        if (va) decls.push(`vertical-align:${va}`);
        const vm = findChild(p, "w:vMerge");
        if (vm) vMerge = attrOf(vm, "w:val") ?? "continue";
        tcBorders = readBorders(findChild(p, "w:tcBorders"));
        if (tcBorders) hasAnyBorderSource = true;
      }

      if (vMerge === "continue") {
        const owner = grid[col];
        if (owner) owner.rows += 1; // 위 restart 셀의 rowspan 증가
        col += colspan;
        continue;
      }

      // 셀 위치별 실효 테두리: tcBorders > (가장자리면 tblBorders 외곽변, 안쪽이면 insideH/V).
      if (tableBorders || tcBorders) {
        const lastCol = numCols > 0 ? col + colspan >= numCols : true; // grid 모르면 보수적으로 외곽 취급
        const pick = (side: "top" | "bottom" | "left" | "right", outer: boolean, inner: BorderSide): Side | undefined =>
          tcBorders?.[side] ?? (outer ? tableBorders?.[side] : tableBorders?.[inner]);
        const top = pick("top", rowIndex === 0, "insideH");
        const bottom = pick("bottom", rowIndex === numRows - 1, "insideH");
        const left = pick("left", col === 0, "insideV");
        const right = pick("right", lastCol, "insideV");
        decls.push(
          `border-top:${sideToCss(top)}`,
          `border-bottom:${sideToCss(bottom)}`,
          `border-left:${sideToCss(left)}`,
          `border-right:${sideToCss(right)}`,
        );
      }

      const cell: RenderedCell = {
        html: renderNodes(tcKids, ctx) || "&#8203;",
        colspan,
        style: decls.join(";"),
        rows: 1,
      };
      cellsInRow.push(cell);
      for (let k = 0; k < colspan; k++) grid[col + k] = vMerge === "restart" ? cell : undefined;
      col += colspan;
    }
    rowCells.push(cellsInRow);
  });

  const rows = rowCells
    .map((cells) => {
      const tds = cells
        .map((c) => {
          const span = (c.colspan > 1 ? ` colspan="${c.colspan}"` : "") + (c.rows > 1 ? ` rowspan="${c.rows}"` : "");
          const styleAttr = c.style ? ` style="${c.style}"` : "";
          return `<td${span}${styleAttr}>${c.html}</td>`;
        })
        .join("");
      return `<tr>${tds}</tr>`;
    })
    .join("");
  // tblGrid 의 열너비(w:gridCol)를 colgroup(퍼센트)로 반영 + table-layout:fixed →
  // 빈 셀이 쪼그라들지 않고 원본 열 비율(라벨 좁게·값 넓게 등)을 그대로 유지한다.
  const colW = gridDef ? findChildren(childrenOf(gridDef), "w:gridCol").map((g) => Number(attrOf(g, "w:w")) || 0) : [];
  const totalW = colW.reduce((a, b) => a + b, 0);
  const colgroup =
    colW.length > 0 && totalW > 0
      ? `<colgroup>${colW.map((w) => `<col style="width:${((w / totalW) * 100).toFixed(3)}%"/>`).join("")}</colgroup>`
      : "";
  // 실제 테두리를 인라인으로 입힌 표는 회색 기본 테두리를 끄도록 클래스로 표시.
  const cls = hasAnyBorderSource ? "docloom-table docloom-table-bordered" : "docloom-table";
  const tblStyle = colgroup ? ` style="table-layout:fixed"` : "";
  return `<table class="${cls}"${tblStyle}>${colgroup}<tbody>${rows}</tbody></table>`;
}

// ── 목록(글머리기호/번호) ─────────────────────────────────────────────────

interface NumLevel {
  numFmt: string;
  lvlText: string;
  bulletFont?: string; // 글머리표 글리프 폰트(Wingdings/Symbol 판별용)
  indLeft?: number; // 레벨 들여쓰기(twips)
  indHanging?: number; // 내어쓰기(twips)
  indFirstLine?: number; // 첫줄 들여쓰기(twips)
}
interface Numbering {
  // numId → ilvl → level
  levels: Map<string, Map<number, NumLevel>>;
}

function buildNumbering(parts: Record<string, Uint8Array>, dec: InstanceType<typeof TextDecoder>): Numbering {
  const empty: Numbering = { levels: new Map() };
  const buf = parts["word/numbering.xml"];
  if (!buf) return empty;
  const tree = parseXml(dec.decode(buf));
  const root = tree.find((n) => tagOf(n) === "w:numbering");
  if (!root) return empty;
  const top = childrenOf(root);

  // abstractNumId → (ilvl → level)
  const abstract = new Map<string, Map<number, NumLevel>>();
  for (const an of findChildren(top, "w:abstractNum")) {
    const aId = attrOf(an, "w:abstractNumId");
    if (!aId) continue;
    const lvls = new Map<number, NumLevel>();
    for (const lvl of findChildren(childrenOf(an), "w:lvl")) {
      const ilvl = Number(attrOf(lvl, "w:ilvl") ?? "0");
      const lk = childrenOf(lvl);
      const numFmt = attrOf(findChild(lk, "w:numFmt") ?? {}, "w:val") ?? "decimal";
      const lvlText = attrOf(findChild(lk, "w:lvlText") ?? {}, "w:val") ?? "%1.";
      const rPr = findChild(lk, "w:rPr");
      const rFonts = rPr ? findChild(childrenOf(rPr), "w:rFonts") : undefined;
      const bulletFont = rFonts
        ? attrOf(rFonts, "w:ascii") ?? attrOf(rFonts, "w:hAnsi") ?? attrOf(rFonts, "w:cs")
        : undefined;
      const lvlPPr = findChild(lk, "w:pPr");
      const lvlInd = lvlPPr ? findChild(childrenOf(lvlPPr), "w:ind") : undefined;
      const num = (v: string | undefined) => (v !== undefined && Number.isFinite(Number(v)) ? Number(v) : undefined);
      const indLeft = lvlInd ? num(attrOf(lvlInd, "w:left") ?? attrOf(lvlInd, "w:start")) : undefined;
      const indHanging = lvlInd ? num(attrOf(lvlInd, "w:hanging")) : undefined;
      const indFirstLine = lvlInd ? num(attrOf(lvlInd, "w:firstLine")) : undefined;
      lvls.set(ilvl, { numFmt, lvlText, bulletFont, indLeft, indHanging, indFirstLine });
    }
    abstract.set(aId, lvls);
  }
  // numId → abstractNumId
  const levels = new Map<string, Map<number, NumLevel>>();
  for (const num of findChildren(top, "w:num")) {
    const numId = attrOf(num, "w:numId");
    if (!numId) continue;
    const aId = attrOf(findChild(childrenOf(num), "w:abstractNumId") ?? {}, "w:val");
    if (aId && abstract.has(aId)) levels.set(numId, abstract.get(aId)!);
  }
  return { levels };
}

/** styles.xml 의 문단 스타일에 직접 박힌 numPr → styleId 맵. */
function buildStyleNum(
  parts: Record<string, Uint8Array>,
  dec: InstanceType<typeof TextDecoder>,
): Map<string, { numId: string; ilvl: number }> {
  const map = new Map<string, { numId: string; ilvl: number }>();
  const buf = parts["word/styles.xml"];
  if (!buf) return map;
  const tree = parseXml(dec.decode(buf));
  const root = tree.find((n) => tagOf(n) === "w:styles");
  if (!root) return map;
  for (const st of findChildren(childrenOf(root), "w:style")) {
    const styleId = attrOf(st, "w:styleId");
    if (!styleId) continue;
    const pPr = findChild(childrenOf(st), "w:pPr");
    if (!pPr) continue;
    const numPr = findChild(childrenOf(pPr), "w:numPr");
    if (!numPr) continue;
    const numId = attrOf(findChild(childrenOf(numPr), "w:numId") ?? {}, "w:val");
    if (!numId) continue;
    const ilvl = Number(attrOf(findChild(childrenOf(numPr), "w:ilvl") ?? {}, "w:val") ?? "0");
    map.set(styleId, { numId, ilvl });
  }
  return map;
}

const SYMBOL_BULLETS: Record<number, string> = {
  0xf0b7: "•", // Symbol/Wingdings: 둥근 점
  0x00b7: "·",
  0xf0a7: "▪", // Wingdings: 작은 검은 사각
  0xf06e: "■", // Wingdings 'n': 검은 사각
  0xf06c: "●", // Wingdings 'l': 큰 검은 원
  0xf071: "◆", // Wingdings 'q': 검은 마름모
  0xf075: "◆",
  0xf0d8: "➢", // Wingdings: 화살촉
  0xf0fc: "✔",
  0xf0a8: "▪",
};

function isSymbolFont(f?: string): boolean {
  return !!f && /wingding|webding|symbol|marlett/i.test(f);
}

/** 글머리표 글리프: 실제 lvlText 를 살리되, 심볼폰트/사유영역 문자는 유니코드 불릿으로 매핑. */
function bulletGlyph(lvlText: string, font?: string): string {
  if (!lvlText) return "•";
  const cp = lvlText.codePointAt(0)!;
  if (isSymbolFont(font) || (cp >= 0xf000 && cp <= 0xf0ff)) {
    return SYMBOL_BULLETS[cp] ?? "•";
  }
  return lvlText; // "-", "*", "o", "▪" 등 일반 글자 그대로
}

/** 번호 레벨의 들여쓰기 → CSS(margin-left + 내어쓰기 text-indent). 마커가 내어쓰기 칸에 놓인다. */
function levelIndentCss(level: NumLevel): string {
  const d: string[] = [];
  if (level.indLeft !== undefined) d.push(`margin-left:${round(level.indLeft / 20)}pt`);
  if (level.indHanging !== undefined) d.push(`text-indent:${round(-level.indHanging / 20)}pt`);
  else if (level.indFirstLine !== undefined) d.push(`text-indent:${round(level.indFirstLine / 20)}pt`);
  return d.join(";");
}

/** 문단의 목록 레벨 해석: 직접 numPr > 스타일 numPr. 없거나 numId=0 이면 null. */
function resolveListLevel(
  pPr: XmlNode | undefined,
  styleId: string | undefined,
  ctx: Ctx,
): { level: NumLevel; numId: string; ilvl: number } | null {
  let numId: string | undefined;
  let ilvl = 0;
  const numPr = pPr ? findChild(childrenOf(pPr), "w:numPr") : undefined;
  if (numPr) {
    numId = attrOf(findChild(childrenOf(numPr), "w:numId") ?? {}, "w:val");
    ilvl = Number(attrOf(findChild(childrenOf(numPr), "w:ilvl") ?? {}, "w:val") ?? "0");
  } else if (styleId && ctx.styleNum.has(styleId)) {
    const s = ctx.styleNum.get(styleId)!;
    numId = s.numId;
    ilvl = s.ilvl;
  }
  if (!numId || numId === "0") return null; // numId 0 = 번호 제거(Word 관례)
  const level = ctx.numbering.levels.get(numId)?.get(ilvl);
  if (!level) return null;
  return { level, numId, ilvl };
}

/** 목록 레벨 → 마커 HTML. 글머리기호(실제 lvlText) 또는 번호(카운터). */
function listMarker(resolved: { level: NumLevel; numId: string; ilvl: number }, ctx: Ctx): string {
  const { level, numId, ilvl } = resolved;
  if (level.numFmt === "none") return "";
  if (level.numFmt === "bullet") {
    return `<span class="docloom-marker">${escapeHtml(bulletGlyph(level.lvlText, level.bulletFont))}</span> `;
  }

  // 번호: numId 별 카운터 배열 유지
  let counts = ctx.counters.get(numId);
  if (!counts) {
    counts = [];
    ctx.counters.set(numId, counts);
  }
  counts[ilvl] = (counts[ilvl] ?? 0) + 1;
  for (let k = ilvl + 1; k < counts.length; k++) counts[k] = 0; // 하위 레벨 리셋

  // lvlText 의 %1,%2... 를 각 레벨 카운터로 치환
  const text = level.lvlText.replace(/%(\d+)/g, (_, n: string) => String(counts![Number(n) - 1] ?? 1));
  return `<span class="docloom-marker">${escapeHtml(text)}</span> `;
}

// ── 유틸 ──────────────────────────────────────────────────────────────────

function buildRels(parts: Record<string, Uint8Array>, path: string, dec: InstanceType<typeof TextDecoder>): Map<string, string> {
  const map = new Map<string, string>();
  const buf = parts[path];
  if (!buf) return map;
  const tree = parseXml(dec.decode(buf));
  const root = tree.find((n) => tagOf(n) === "Relationships");
  if (!root) return map;
  for (const rel of childrenOf(root)) {
    if (tagOf(rel) !== "Relationship") continue;
    const id = attrOf(rel, "Id");
    const target = attrOf(rel, "Target");
    if (id && target) map.set(id, target);
  }
  return map;
}

function isOn(node: XmlNode | undefined): boolean {
  if (!node) return false;
  const v = attrOf(node, "w:val");
  if (v === undefined) return true;
  return !["0", "false", "none", "off"].includes(v.toLowerCase());
}

function mapAlign(v: string | undefined): string | undefined {
  switch (v) {
    case "both":
    case "distribute":
      return "justify";
    case "center":
      return "center";
    case "right":
    case "end":
      return "right";
    case "left":
    case "start":
      return "left";
    default:
      return undefined;
  }
}

function round(x: number): number {
  return Math.round(x * 100) / 100;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}
