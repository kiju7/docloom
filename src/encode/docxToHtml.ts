/**
 * encode: docx → (DocModel) → 제약 의미적 HTML + Manifest
 *
 * 파이프라인
 *   1) zip 해제 → originalParts 확보 (그대로 Manifest 에 보관)
 *   2) word/document.xml 파싱 → body 의 자식 노드 순회
 *   3) 이해 가능한 노드(문단/제목) → DocModel 블록
 *      이해 못 하는 노드(표·도형 등) → FrozenBlock (원본 XML 은 Manifest.frozen 에)
 *   4) DocModel → HTML 직렬화 (class = s-<styleKey>, 인라인스타일 없음)
 *   5) { html, manifest } 반환
 */
import type { Palette } from "../palette/palette.js";
import {
  DEFAULT_PALETTE,
  classFromStyleKey,
  htmlTagFromStyleKey,
  styleKeyFromDocxId,
} from "../palette/palette.js";
import type { DocModel, Block, Run } from "../model/docModel.js";
import type { Manifest } from "../model/manifest.js";
import { readDocxZip, partToText } from "../docx/zip.js";
import {
  DOCUMENT_PART,
  parseXml,
  findBody,
  splitBodyChildren,
  readParagraphStyleId,
  readParagraphDirectPPrXml,
  readRuns,
  tagOf,
  childrenOf,
  attrOf,
  findChild,
  findChildren,
  buildXml,
  type XmlNode,
  type RawRun,
} from "../docx/ooxml.js";
import type { Table, TableRow, TableCell } from "../model/docModel.js";

export interface EncodeOptions {
  palette?: Palette;
  /**
   * true 면 표(w:tbl)를 frozen 으로 보존하지 않고 HTML <table> 로 펼친다.
   * 미리보기 전용. 왕복(decode)에는 사용하지 말 것 — 표는 frozen 보존이 원칙.
   */
  expandTables?: boolean;
}

export interface EncodeResult {
  html: string;
  manifest: Manifest;
  /** 디버깅/테스트용 중간 모델 */
  model: DocModel;
}

/** encode 중 직접서식(w:pPr/w:rPr) 조각·frozen 런을 토큰화해 모으는 누산기. */
interface PropStore {
  props: Record<string, string>;
  pSeq: number;
  rSeq: number;
  /** frozen 런(이미지·도형) 보관소(= manifest.frozen 과 같은 객체). */
  frozen: Record<string, string>;
  frunSeq: number;
}

export function encodeToHtml(docx: Uint8Array, opts: EncodeOptions = {}): EncodeResult {
  const palette = opts.palette ?? DEFAULT_PALETTE;
  const originalParts = readDocxZip(docx);

  const doc = parseXml(partToText(originalParts, DOCUMENT_PART));
  const body = findBody(doc);
  const { content } = splitBodyChildren(body);

  const blocks: Block[] = [];
  const frozen: Record<string, string> = {};
  const store: PropStore = { props: {}, pSeq: 0, rSeq: 0, frozen, frunSeq: 0 };
  let frozenSeq = 0;

  for (const node of content) {
    const tag = tagOf(node);
    if (tag === "w:p") {
      blocks.push(paragraphNodeToBlock(node, palette, store));
    } else if (tag === "w:tbl" && opts.expandTables) {
      // 미리보기 전용: 표를 HTML <table> 로 펼친다 (왕복 아님).
      blocks.push(tableNodeToBlock(node, palette, store));
    } else {
      // 아직 이해하지 못하는 요소(표·도형 등) → 원본 보존 + 자리표시자
      const refId = `frozen-${frozenSeq++}`;
      frozen[refId] = buildXml([node]);
      blocks.push({ type: "frozen", refId, label: frozenLabel(tag) });
    }
  }

  const model: DocModel = { blocks };
  const manifest: Manifest = {
    version: 1,
    originalParts,
    frozen,
    props: store.props,
    paletteId: palette.id,
  };

  const html = serializeModelToHtml(model, palette);
  return { html, manifest, model };
}

function paragraphNodeToBlock(node: XmlNode, palette: Palette, store: PropStore): Block {
  const styleId = readParagraphStyleId(node);
  const styleKey = styleKeyFromDocxId(palette, styleId);
  const runs = rawRunsToRuns(readRuns(node), store);
  const htmlTag = htmlTagFromStyleKey(palette, styleKey);

  // 문단 직접서식(정렬·들여쓰기·간격·번호…) 보존: pStyle 외 내용이 있으면 토큰화
  const pPrXml = readParagraphDirectPPrXml(node);
  const propsRef = pPrXml ? storeProps(store, "pp", pPrXml) : undefined;

  if (/^h[1-6]$/.test(htmlTag)) {
    const level = Number(htmlTag.slice(1)) as 1 | 2 | 3 | 4 | 5 | 6;
    return { type: "heading", level, styleKey, runs, propsRef };
  }
  if (htmlTag === "li") {
    return { type: "listItem", ordered: false, level: 0, styleKey, runs, propsRef };
  }
  return { type: "paragraph", styleKey, runs, propsRef };
}

function storeProps(store: PropStore, kind: "pp" | "rp", xml: string): string {
  const token = kind === "pp" ? `pp-${store.pSeq++}` : `rp-${store.rSeq++}`;
  store.props[token] = xml;
  return token;
}

function rawRunsToRuns(raw: RawRun[], store: PropStore): Run[] {
  return raw.map((r) => {
    // 이미지·도형 런 → manifest.frozen 에 통째로 보관, 모델엔 토큰+라벨만
    if (r.frozenXml) {
      const token = `frun-${store.frunSeq++}`;
      store.frozen[token] = r.frozenXml;
      return { text: "", frozenRef: token, label: r.frozenLabel ?? "[개체]" };
    }
    const run: Run = { text: r.text };
    if (r.marks.length > 0) run.marks = r.marks as Run["marks"];
    if (r.rPrXml) run.propsRef = storeProps(store, "rp", r.rPrXml);
    return run;
  });
}

/** w:tbl → Table 블록 (미리보기용). 셀의 문단을 그대로 블록으로 담는다. */
function tableNodeToBlock(node: XmlNode, palette: Palette, store: PropStore): Table {
  const rows: TableRow[] = [];
  for (const tr of findChildren(childrenOf(node), "w:tr")) {
    const cells: TableCell[] = [];
    for (const tc of findChildren(childrenOf(tr), "w:tc")) {
      const tcKids = childrenOf(tc);
      const tcPr = findChild(tcKids, "w:tcPr");
      let colSpan: number | undefined;
      if (tcPr) {
        const gs = findChild(childrenOf(tcPr), "w:gridSpan");
        const n = gs ? Number(attrOf(gs, "w:val")) : NaN;
        if (Number.isFinite(n) && n > 1) colSpan = n;
        // vMerge(세로 병합)는 v1 미리보기에서 미처리 — 각 셀로 표시될 수 있음
      }
      const cellBlocks = findChildren(tcKids, "w:p").map((p) => paragraphNodeToBlock(p, palette, store));
      cells.push({ styleKey: palette.fallbackStyleKey, blocks: cellBlocks, colSpan });
    }
    rows.push({ cells });
  }
  return { type: "table", styleKey: palette.fallbackStyleKey, rows };
}

function frozenLabel(tag: string): string {
  if (tag === "w:tbl") return "[표]";
  return `[보존된 원본 요소: ${tag}]`;
}

// ── 직렬화 (DocModel → HTML) ─────────────────────────────────────────────

/** 제약 규칙: 허용 태그 + s- class 만, 인라인스타일 금지. */
export function serializeModelToHtml(model: DocModel, palette: Palette): string {
  const body = model.blocks.map((b) => serializeBlock(b, palette)).join("\n");
  return `<div class="docloom-doc" data-palette="${palette.id}">\n${body}\n</div>`;
}

function serializeBlock(block: Block, palette: Palette): string {
  switch (block.type) {
    case "paragraph": {
      const tag = htmlTagFromStyleKey(palette, block.styleKey);
      return `<${tag} class="${classFromStyleKey(block.styleKey)}"${ppAttr(block.propsRef)}>${serializeRuns(block.runs)}</${tag}>`;
    }
    case "heading": {
      const tag = `h${block.level}`;
      return `<${tag} class="${classFromStyleKey(block.styleKey)}"${ppAttr(block.propsRef)}>${serializeRuns(block.runs)}</${tag}>`;
    }
    case "listItem":
      return `<li class="${classFromStyleKey(block.styleKey)}"${ppAttr(block.propsRef)}>${serializeRuns(block.runs)}</li>`;
    case "table":
      return serializeTable(block, palette);
    case "frozen":
      return `<div class="s-frozen" data-frozen="${block.refId}" contenteditable="false">${escapeHtml(
        block.label ?? "[보존된 원본 요소]",
      )}</div>`;
  }
}

/** 문단 직접서식 토큰 → data-pp 속성(없으면 빈 문자열). */
function ppAttr(propsRef: string | undefined): string {
  return propsRef ? ` data-pp="${propsRef}"` : "";
}

function serializeRuns(runs: Run[]): string {
  return runs
    .map((r) => {
      // frozen 런(이미지·도형): LLM 엔 짧은 자리표시자만 — 이미지 바이트는 안 나간다
      if (r.frozenRef) {
        return `<span data-frozen-run="${r.frozenRef}" contenteditable="false">${escapeHtml(r.label ?? "[개체]")}</span>`;
      }
      let t = escapeHtml(r.text).replace(/\n/g, "<br/>");
      for (const m of r.marks ?? []) {
        if (m === "bold") t = `<strong>${t}</strong>`;
        else if (m === "italic") t = `<em>${t}</em>`;
        else if (m === "underline") t = `<u>${t}</u>`;
        else if (m === "strike") t = `<s>${t}</s>`;
      }
      // 런 직접서식(색·크기·폰트…) 보존: 토큰을 data-rp 스팬으로 감싸 왕복
      if (r.propsRef) t = `<span data-rp="${r.propsRef}">${t}</span>`;
      return t;
    })
    .join("");
}

function serializeTable(block: Extract<Block, { type: "table" }>, palette: Palette): string {
  const rows = block.rows
    .map((row) => {
      const cells = row.cells
        .map(
          (c) =>
            `<td class="${classFromStyleKey(c.styleKey)}"${c.colSpan ? ` colspan="${c.colSpan}"` : ""}${
              c.rowSpan ? ` rowspan="${c.rowSpan}"` : ""
            }>${c.blocks.map((b) => serializeBlock(b, palette)).join("")}</td>`,
        )
        .join("");
      return `<tr>${cells}</tr>`;
    })
    .join("");
  return `<table class="${classFromStyleKey(block.styleKey)}"><tbody>${rows}</tbody></table>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
