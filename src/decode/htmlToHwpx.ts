/**
 * decode: 제약 HTML + Manifest → hwpx
 *
 * docx 파이프라인(decode/htmlToDocx.ts)의 HWPX 판. validator·HTML→DocModel 파서는
 * 그대로 공유하고, 본문 재조립만 OWPML 로 바꾼다. 핵심 철학은 동일:
 *   원본 part 는 전부 보존(manifest.originalParts), 섹션 XML 의 hp:p 본문만 재생성.
 *
 *   1) validateHtml(공유) → parseHtmlToModel(공유) → DocModel
 *   2) 섹션 경계 마커(secbound-*)로 블록을 섹션별 그룹으로 분리
 *   3) 각 섹션: 원본 section XML 재파싱 → hp:p 자식만 재생성 노드로 교체
 *      (paraPrIDRef/styleIDRef 등 원본 속성·charPrIDRef 그대로 복원, 개체 런은 frozen 원본)
 *   4) 나머지 part(header·BinData·settings…)는 손대지 않고 section XML 만 교체 → zip
 */
import type { Palette } from "../palette/palette.js";
import { buildPaletteFromHwpx } from "../palette/fromHwpx.js";
import { docxIdFromStyleKey } from "../palette/palette.js";
import { validateHtml } from "../validate/validator.js";
import type { Manifest } from "../model/manifest.js";
import type { Block, Run } from "../model/docModel.js";
import { parseHtmlToModel } from "./htmlToDocx.js";
import { writeZip, partToText, textToPart, tryPartToText } from "../core/zip.js";
import { findDeep, deepText, makeTextNode, childrenOf, tagOf, findChildren } from "../core/xml.js";
import {
  HEADER_PART,
  type XmlNode,
  parseXml,
  buildXml,
  findSectionRoot,
  setChildren,
  makeTextRunNode,
  makeFrozenRunNode,
  makeParagraphNode,
} from "../hwpx/owpml.js";

export interface HwpxDecodeOptions {
  palette?: Palette;
  /** true 면 validator 정규화를 건너뛴다. 기본 false. */
  skipValidate?: boolean;
}

export function decodeHtmlToHwpx(html: string, manifest: Manifest, opts: HwpxDecodeOptions = {}): Uint8Array {
  const headerXml = tryPartToText(manifest.originalParts, HEADER_PART);
  const palette = opts.palette ?? buildPaletteFromHwpx(headerXml);
  if (manifest.paletteId !== palette.id) {
    throw new Error(`팔레트 불일치: manifest=${manifest.paletteId} vs decode=${palette.id}.`);
  }

  const safeHtml = opts.skipValidate ? html : validateHtml(html, palette).html;
  const model = parseHtmlToModel(safeHtml, palette);

  const sectionPaths: string[] = JSON.parse(manifest.native?.sectionPaths ?? "[]");
  if (sectionPaths.length === 0) throw new Error("HWPX manifest: sectionPaths 누락");

  // 섹션 경계 마커로 블록을 섹션별로 분리
  const groups: Block[][] = [[]];
  for (const b of model.blocks) {
    if (b.type === "frozen" && b.refId.startsWith("secbound-")) {
      groups.push([]);
    } else {
      groups[groups.length - 1]!.push(b);
    }
  }

  const parts: Record<string, Uint8Array> = { ...manifest.originalParts };
  sectionPaths.forEach((path, i) => {
    const doc = parseXml(partToText(manifest.originalParts, path));
    const root = findSectionRoot(doc);
    const blocks = groups[i] ?? [];
    setChildren(root, blocks.map((b) => blockToParagraph(b, manifest, palette)));
    parts[path] = textToPart(buildXml(doc));
  });

  return writeZip(parts);
}

/** DocModel 블록 → hp:p 노드. (신규 문단도 팔레트 styleIDRef 로 유효 속성 부여) */
function blockToParagraph(block: Block, manifest: Manifest, palette: Palette): XmlNode {
  if (block.type === "frozen") {
    // 문단 수준 frozen(미사용 경로) — 안전하게 빈 문단으로 대체
    return makeParagraphNode(undefined, []);
  }
  if (block.type === "table") {
    // 편집 가능 표: 원본 hp:p(manifest.frozen[sourceRef]) 를 가져와 바뀐 셀의 hp:t 만 갈아끼운다.
    if (!block.sourceRef) return makeParagraphNode(undefined, []);
    const xml = manifest.frozen[block.sourceRef];
    if (xml === undefined) throw new Error(`HWPX 표 원본 누락: ${block.sourceRef}`);
    const p = parseXml(xml).find((n) => tagOf(n) === "hp:p");
    if (!p) throw new Error(`HWPX 표 원본에 hp:p 없음: ${block.sourceRef}`);
    patchHwpxTableCells(p, block);
    return p;
  }
  const runs = (block.runs as Run[]).map((r) => runToNode(r, manifest));
  const attrsJson = block.propsRef ? manifest.props[block.propsRef] : undefined;
  return makeParagraphNode(attrsJson, runs, { styleIDRef: docxIdFromStyleKey(palette, block.styleKey) });
}

function runToNode(run: Run, manifest: Manifest): XmlNode {
  if (run.frozenRef) {
    const xml = manifest.frozen[run.frozenRef];
    if (xml === undefined) throw new Error(`HWPX: frozen 런 원본 누락: ${run.frozenRef}`);
    return makeFrozenRunNode(xml);
  }
  // 신규 런(propsRef 없음)은 기본 문자속성 0 으로 부여.
  const charPrRef = run.propsRef ? manifest.props[run.propsRef] : "0";
  return makeTextRunNode(run.text, charPrRef);
}

/** 편집된 셀 텍스트를 원본 hp:p 안 hp:tbl 에 반영(바뀐 셀만 — 미변경 셀·서식은 원본 보존). */
function patchHwpxTableCells(p: XmlNode, block: Extract<Block, { type: "table" }>): void {
  const tbl = findDeep([p], "hp:tbl");
  if (!tbl) return;
  const trs = findChildren(childrenOf(tbl), "hp:tr");
  block.rows.forEach((row, r) => {
    const tr = trs[r];
    if (!tr) return;
    const tcs = findChildren(childrenOf(tr), "hp:tc");
    row.cells.forEach((cell, c) => {
      const tc = tcs[c];
      if (!tc || cell.cellRef === undefined) return;
      const next = cell.text ?? "";
      if (next === deepText(tc)) return; // 변경 없음 → 원본 셀 그대로(서식 보존)
      setHwpxCellText(tc, next);
    });
  });
}

/** hp:tc 의 텍스트를 새 값으로 교체: 기존 hp:t 가 있으면 그 텍스트만, 없으면 셀 문단에 런을 만든다. */
function setHwpxCellText(tc: XmlNode, text: string): void {
  const tNode = findDeep(childrenOf(tc), "hp:t");
  if (tNode) {
    setChildren(tNode, [makeTextNode(text)]);
    return;
  }
  // 빈 셀: 셀 안 hp:p(보통 hp:subList 하위)에 텍스트 런을 넣는다.
  const cellP = findDeep(childrenOf(tc), "hp:p");
  if (cellP) {
    const keep = childrenOf(cellP).filter((n) => tagOf(n) !== "hp:run" && tagOf(n) !== "hp:linesegarray");
    setChildren(cellP, [makeTextRunNode(text, "0"), ...keep]);
  }
}
