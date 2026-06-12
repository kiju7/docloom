/**
 * decode: 제약 HTML + Manifest → docx
 *
 * 파이프라인
 *   1) (TODO) validator 로 HTML 정규화
 *   2) HTML → DocModel (class → styleKey, frozen 자리표시자 → FrozenBlock)
 *   3) 원본 document.xml 을 다시 파싱해 body 만 새 콘텐츠로 교체
 *      - styleKey → docx styleId (팔레트)
 *      - FrozenBlock → Manifest.frozen[refId] 원본 XML 그대로 삽입
 *      - 끝의 sectPr 은 원본 그대로 유지
 *   4) 나머지 part(스타일·머리말·이미지…)는 손대지 않고 document.xml 만 교체 → zip
 *
 * 주의: v0 는 HTML 을 fast-xml-parser 로 파싱한다(docloom 이 생성한 well-formed
 * XHTML 기준). LLM 이 손댄 임의 HTML 은 validator 단계에서 정규화·교정한 뒤
 * 넘겨야 한다(아직 미구현).
 */
import type { Palette } from "../palette/palette.js";
import { DEFAULT_PALETTE, docxIdFromStyleKey, styleKeyFromClass } from "../palette/palette.js";
import { validateHtml } from "../validate/validator.js";
import type { Manifest } from "../model/manifest.js";
import type { DocModel, Block, Run } from "../model/docModel.js";
import { writeDocxZip, partToText, textToPart } from "../docx/zip.js";
import {
  DOCUMENT_PART,
  parseXml,
  buildXml,
  findBody,
  splitBodyChildren,
  setChildren,
  tagOf,
  textOf,
  childrenOf,
  attrOf,
  makeParagraphNodeFull,
  type XmlNode,
  type RawRun,
} from "../docx/ooxml.js";

export interface DecodeOptions {
  palette?: Palette;
  /** true 면 validator 정규화를 건너뛴다(이미 신뢰 가능한 HTML 일 때). 기본 false. */
  skipValidate?: boolean;
}

export function decodeToDocx(html: string, manifest: Manifest, opts: DecodeOptions = {}): Uint8Array {
  const palette = opts.palette ?? DEFAULT_PALETTE;
  if (manifest.paletteId !== palette.id) {
    throw new Error(
      `팔레트 불일치: manifest=${manifest.paletteId} vs decode=${palette.id}. 같은 팔레트로 왕복해야 함.`,
    );
  }

  // LLM/사람이 만진 HTML 을 신뢰하지 않는다 — 기본적으로 정규화 후 파싱.
  const safeHtml = opts.skipValidate ? html : validateHtml(html, palette).html;
  const model = parseHtmlToModel(safeHtml, palette);

  // 원본 document.xml 을 다시 파싱 → body 콘텐츠만 교체 (sectPr·네임스페이스 보존)
  const doc = parseXml(partToText(manifest.originalParts, DOCUMENT_PART));
  const body = findBody(doc);
  const { sectPr } = splitBodyChildren(body);

  const newContent = model.blocks.flatMap((b) => blockToNodes(b, manifest, palette));
  setChildren(body, sectPr ? [...newContent, sectPr] : newContent);

  const documentXml = buildXml(doc);
  const parts: Record<string, Uint8Array> = {
    ...manifest.originalParts,
    [DOCUMENT_PART]: textToPart(documentXml),
  };
  return writeDocxZip(parts);
}

/** DocModel 블록 → OOXML 노드들. */
function blockToNodes(block: Block, manifest: Manifest, palette: Palette): XmlNode[] {
  switch (block.type) {
    case "paragraph":
    case "heading":
    case "listItem": {
      const styleId = docxIdFromStyleKey(palette, block.styleKey);
      // 보존된 문단 직접서식(정렬·들여쓰기·간격·번호…) 복원. 없으면 단순 문단.
      const pPrXml = block.propsRef ? manifest.props[block.propsRef] : undefined;
      return [makeParagraphNodeFull(pPrXml, styleId, runsToRaw(block.runs, manifest))];
    }
    case "frozen": {
      const xml = manifest.frozen[block.refId];
      if (xml === undefined) throw new Error(`frozen 원본 누락: ${block.refId}`);
      return parseXml(xml);
    }
    case "table": {
      // 편집 가능 표: 원본 w:tbl(manifest.frozen[sourceRef])을 가져와 바뀐 셀 텍스트만 갈아끼운다.
      // sourceRef 가 없으면 미리보기용 expandTables 표 → 왕복 불가(원칙상 도달 안 함).
      if (!block.sourceRef) {
        throw new Error("table 블록 재생성 불가: sourceRef 없음(미리보기 expandTables 표는 왕복 대상이 아님)");
      }
      const xml = manifest.frozen[block.sourceRef];
      if (xml === undefined) throw new Error(`표 원본 누락: ${block.sourceRef}`);
      const tbl = parseXml(xml).find((n) => tagOf(n) === "w:tbl");
      if (!tbl) throw new Error(`표 원본에 w:tbl 없음: ${block.sourceRef}`);
      patchTableCells(tbl, block);
      return [tbl];
    }
  }
}

/** 편집된 셀 텍스트를 원본 w:tbl 에 반영(바뀐 셀만 — 미변경 셀은 원본 그대로 보존). */
function patchTableCells(tbl: XmlNode, block: Extract<Block, { type: "table" }>): void {
  const trs = childrenOf(tbl).filter((n) => tagOf(n) === "w:tr");
  block.rows.forEach((row, r) => {
    const tr = trs[r];
    if (!tr) return;
    const tcs = childrenOf(tr).filter((n) => tagOf(n) === "w:tc");
    row.cells.forEach((cell, c) => {
      const tc = tcs[c];
      if (!tc || cell.cellRef === undefined) return;
      const next = cell.text ?? "";
      if (next === docxCellText(tc)) return; // 변경 없음 → 원본 셀(서식·구조) 그대로
      setDocxCellText(tc, next);
    });
  });
}

/** w:tc 안 모든 w:p 텍스트를 줄바꿈으로 이어 평문으로(encode 측과 동일 규칙). */
function docxCellText(tc: XmlNode): string {
  return childrenOf(tc)
    .filter((n) => tagOf(n) === "w:p")
    .map((p) =>
      childrenOf(p)
        .filter((n) => tagOf(n) === "w:r")
        .flatMap((rn) => childrenOf(rn).filter((n) => tagOf(n) === "w:t"))
        .map((t) => textOf(childrenOf(t)[0] ?? {}) ?? "")
        .join(""),
    )
    .join("\n");
}

/** 셀 텍스트 교체: 첫 w:p 의 w:pPr 는 유지하고 본문을 새 텍스트 한 런으로 대체(w:tcPr 보존). */
function setDocxCellText(tc: XmlNode, text: string): void {
  const kids = childrenOf(tc);
  const tcPr = kids.find((n) => tagOf(n) === "w:tcPr");
  const firstP = kids.find((n) => tagOf(n) === "w:p");
  const pPr = firstP ? childrenOf(firstP).find((n) => tagOf(n) === "w:pPr") : undefined;
  const runNode: XmlNode = {
    "w:r": [{ "w:t": [{ "#text": text }], ":@": { "@_xml:space": "preserve" } }],
  } as unknown as XmlNode;
  const newP: XmlNode = { "w:p": pPr ? [pPr, runNode] : [runNode] } as unknown as XmlNode;
  setChildren(tc, tcPr ? [tcPr, newP] : [newP]);
}

/** <table data-table> + <td data-cell> → 편집 가능 Table 블록(원본 복원은 decode 가 sourceRef 로). */
function parseTableToBlock(node: XmlNode, palette: Palette): Block {
  const sourceRef = attrOf(node, "data-table");
  const styleKey = styleKeyFromClass(palette, attrOf(node, "class"));
  const tbody = childrenOf(node).find((n) => tagOf(n) === "tbody") ?? node;
  const rows = childrenOf(tbody)
    .filter((n) => tagOf(n) === "tr")
    .map((tr) => ({
      cells: childrenOf(tr)
        .filter((n) => tagOf(n) === "td" || tagOf(n) === "th")
        .map((td) => {
          const cell: import("../model/docModel.js").TableCell = {
            styleKey: styleKeyFromClass(palette, attrOf(td, "class")),
            blocks: [],
            cellRef: attrOf(td, "data-cell"),
            text: readHtmlRuns(td).map((r) => r.text).join(""),
          };
          const cs = Number(attrOf(td, "colspan"));
          const rs = Number(attrOf(td, "rowspan"));
          if (Number.isFinite(cs) && cs > 1) cell.colSpan = cs;
          if (Number.isFinite(rs) && rs > 1) cell.rowSpan = rs;
          return cell;
        }),
    }));
  return { type: "table", styleKey, rows, sourceRef };
}

function runsToRaw(runs: Run[], manifest: Manifest): RawRun[] {
  return runs.map((r) => {
    // frozen 런(이미지·도형): 원본 w:r 을 manifest 에서 그대로 복원
    if (r.frozenRef) {
      return { text: "", marks: [], frozenXml: manifest.frozen[r.frozenRef] };
    }
    const raw: RawRun = { text: r.text, marks: (r.marks ?? []) as string[] };
    // 보존된 런 직접서식(색·크기·폰트…) 복원
    if (r.propsRef && manifest.props[r.propsRef]) raw.rPrXml = manifest.props[r.propsRef];
    return raw;
  });
}

// ── HTML → DocModel ──────────────────────────────────────────────────────

export function parseHtmlToModel(html: string, palette: Palette): DocModel {
  const tree = parseXml(html);
  const root = tree.find((n) => tagOf(n) === "div");
  if (!root) throw new Error("HTML: 최상위 docloom-doc div 를 찾을 수 없음");

  const blocks: Block[] = [];
  for (const node of childrenOf(root)) {
    const tag = tagOf(node);
    if (tag === "#text") continue; // 블록 사이 공백
    const cls = attrOf(node, "class");

    if (tag === "div" && attrOf(node, "data-frozen") !== undefined) {
      blocks.push({ type: "frozen", refId: attrOf(node, "data-frozen")!, label: textOf(childrenOf(node)[0] ?? {}) });
      continue;
    }

    if (tag === "table") {
      blocks.push(parseTableToBlock(node, palette));
      continue;
    }

    const styleKey = styleKeyFromClass(palette, cls);
    const runs = readHtmlRuns(node);
    const propsRef = attrOf(node, "data-pp");

    if (/^h[1-6]$/.test(tag)) {
      const level = Number(tag.slice(1)) as 1 | 2 | 3 | 4 | 5 | 6;
      blocks.push({ type: "heading", level, styleKey, runs, propsRef });
    } else if (tag === "li") {
      blocks.push({ type: "listItem", ordered: false, level: 0, styleKey, runs, propsRef });
    } else {
      blocks.push({ type: "paragraph", styleKey, runs, propsRef });
    }
  }
  return { blocks };
}

type MarkName = "bold" | "italic" | "underline" | "strike";
const HTML_MARKS: Record<string, MarkName> = {
  strong: "bold",
  em: "italic",
  u: "underline",
  s: "strike",
};

/** 인라인 HTML(텍스트 + strong/em/u/s/span[data-rp]/br) → Run[]. */
function readHtmlRuns(node: XmlNode): Run[] {
  const runs: Run[] = [];
  const make = (text: string, marks: NonNullable<Run["marks"]>, propsRef: string | undefined): Run => {
    const run: Run = { text };
    if (marks.length) run.marks = [...marks];
    if (propsRef) run.propsRef = propsRef;
    return run;
  };
  const walk = (children: XmlNode[], marks: NonNullable<Run["marks"]>, propsRef: string | undefined): void => {
    for (const c of children) {
      const t = tagOf(c);
      if (t === "#text") {
        const tx = textOf(c);
        if (tx !== undefined && tx.length > 0) runs.push(make(tx, marks, propsRef));
      } else if (t === "br") {
        runs.push(make("\n", marks, propsRef));
      } else if (t in HTML_MARKS) {
        walk(childrenOf(c), [...marks, HTML_MARKS[t]!], propsRef);
      } else {
        // frozen 런 자리표시자: 원본 이미지/도형으로 복원될 런 (내부 라벨 텍스트는 버림)
        const fr = attrOf(c, "data-frozen-run");
        if (fr) {
          runs.push({ text: "", frozenRef: fr });
          continue;
        }
        // span 등 인라인 래퍼: data-rp 가 있으면 런 직접서식 토큰을 안쪽으로 전파
        const rp = attrOf(c, "data-rp");
        walk(childrenOf(c), marks, rp ?? propsRef);
      }
    }
  };
  walk(childrenOf(node), [], undefined);
  return runs;
}
