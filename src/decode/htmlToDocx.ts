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
    case "table":
      // v0: 표 재생성 미구현. 보통 표는 frozen 으로 보존되므로 여기 도달하지 않음.
      throw new Error("table 블록의 docx 재생성은 아직 미구현 (현재 표는 frozen 으로 보존)");
  }
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
