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

interface Ctx {
  palette: Palette;
  rels: Map<string, string>; // rId → target (word/ 기준 상대경로)
  parts: Record<string, Uint8Array>;
  numbering: Numbering;
  counters: Map<string, number[]>; // numId → 레벨별 카운터
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

  const style = paragraphInlineStyle(pPr);
  const marker = listMarker(pPr, ctx);
  const inner = renderRuns(p, ctx);

  const cls = classFromStyleKey(styleKey);
  const styleAttr = style ? ` style="${style}"` : "";
  return `<${tag} class="${cls}"${styleAttr}>${marker}${inner || "&#8203;"}</${tag}>`;
}

/** 문단 직접서식 → 인라인 CSS (정렬·들여쓰기·간격·문단 하단 테두리). */
function paragraphInlineStyle(pPr: XmlNode | undefined): string {
  if (!pPr) return "";
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
      // auto(기본): 240=1줄 배수. atLeast/exact: twips → pt 높이.
      if (lineRule === "exact" || lineRule === "atLeast") d.push(`line-height:${round(line / 20)}pt`);
      else d.push(`line-height:${round(line / 240)}`);
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
    else if (tag === "w:hyperlink") out += renderRuns(child, ctx); // 링크 안의 런들
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

interface RenderedCell {
  html: string;
  colspan: number;
  style: string; // CSS 선언 묶음 (배경·세로정렬)
  rows: number; // vMerge rowspan (1 = 병합 없음)
}

function renderTable(tbl: XmlNode, ctx: Ctx): string {
  // vMerge(세로 병합): restart 셀이 같은 grid 열에서 이어지는 continue 셀 수만큼 rowspan.
  // continue 셀은 출력하지 않는다. grid 열 위치는 gridSpan(colspan)을 더해 추적한다.
  const grid: (RenderedCell | undefined)[] = []; // 열 index → 현재 열린 restart 셀
  const rowCells: RenderedCell[][] = [];

  for (const tr of findChildren(childrenOf(tbl), "w:tr")) {
    const cellsInRow: RenderedCell[] = [];
    let col = 0;
    for (const tc of findChildren(childrenOf(tr), "w:tc")) {
      const tcKids = childrenOf(tc);
      const tcPr = findChild(tcKids, "w:tcPr");
      let colspan = 1;
      const decls: string[] = [];
      let vMerge: string | undefined;
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
      }

      if (vMerge === "continue") {
        const owner = grid[col];
        if (owner) owner.rows += 1; // 위 restart 셀의 rowspan 증가
        col += colspan;
        continue;
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
  }

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
  return `<table class="docloom-table"><tbody>${rows}</tbody></table>`;
}

// ── 목록(글머리기호/번호) ─────────────────────────────────────────────────

interface NumLevel {
  numFmt: string;
  lvlText: string;
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
      lvls.set(ilvl, { numFmt, lvlText });
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

/** numPr → 마커 HTML. 글머리기호(•) 또는 번호(카운터). 없으면 "". */
function listMarker(pPr: XmlNode | undefined, ctx: Ctx): string {
  if (!pPr) return "";
  const numPr = findChild(childrenOf(pPr), "w:numPr");
  if (!numPr) return "";
  const numId = attrOf(findChild(childrenOf(numPr), "w:numId") ?? {}, "w:val");
  const ilvl = Number(attrOf(findChild(childrenOf(numPr), "w:ilvl") ?? {}, "w:val") ?? "0");
  if (!numId) return "";
  const level = ctx.numbering.levels.get(numId)?.get(ilvl);
  if (!level) return "";

  if (level.numFmt === "bullet") return `<span class="docloom-marker">•</span> `;

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
