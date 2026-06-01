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
    throw new Error("HWPX: table 블록 재생성 미구현 (표는 frozen 런으로 보존)");
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
