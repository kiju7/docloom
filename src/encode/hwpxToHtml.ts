/**
 * encode: hwpx → (DocModel) → 제약 의미적 HTML + Manifest
 *
 * docx 파이프라인(encode/docxToHtml.ts)의 HWPX 판. 컨테이너(zip)·XML·DocModel·팔레트·
 * HTML 직렬화는 그대로 공유하고, 본문 매핑만 OWPML(hp:p/hp:run/hp:t)로 바꾼다.
 *
 *   1) readZip → originalParts (그대로 Manifest 에 보관)
 *   2) Contents/header.xml 로 팔레트 + 문자서식 마크 맵 생성
 *   3) Contents/section*.xml 의 hp:p 순회 → DocModel 블록
 *      텍스트 런 → Run(text, marks, charPrRef 보존) / 개체 런(표·그림·수식) → frozen
 *      섹션 사이엔 경계 frozen 마커를 끼워 decode 가 섹션을 되복원
 *   4) serializeModelToHtml(공유) → HTML
 */
import type { Palette } from "../palette/palette.js";
import {
  classFromStyleKey,
  htmlTagFromStyleKey,
  styleKeyFromDocxId,
} from "../palette/palette.js";
import { buildPaletteFromHwpx, parseCharMarks } from "../palette/fromHwpx.js";
import type { DocModel, Block, Run, Mark } from "../model/docModel.js";
import type { Manifest } from "../model/manifest.js";
import { readZip, partToText, tryPartToText } from "../core/zip.js";
import { serializeModelToHtml } from "./docxToHtml.js";
import {
  buildXml,
  findDeep,
  deepText,
  childrenOf,
  findChild,
  findChildren,
  attrOf,
  type XmlNode,
} from "../core/xml.js";
import type { Table, TableRow, TableCell } from "../model/docModel.js";
import {
  HEADER_PART,
  listSectionPaths,
  parseXml,
  findSectionRoot,
  findParagraphs,
  readParaStyleRef,
  readRuns,
  attrsOf,
} from "../hwpx/owpml.js";

export interface HwpxEncodeOptions {
  palette?: Palette;
  /** true 면 표를 편집 가능 표로 인코딩(원본 hp:p 보존 + 셀 텍스트만 data-cell 로 노출). docx editableTables 의 hwpx 판. */
  editableTables?: boolean;
}

export interface HwpxEncodeResult {
  html: string;
  manifest: Manifest;
  model: DocModel;
}

interface Store {
  props: Record<string, string>;
  frozen: Record<string, string>;
  pSeq: number;
  rSeq: number;
  frunSeq: number;
  tblSeq: number;
}

export function encodeHwpxToHtml(hwpx: Uint8Array, opts: HwpxEncodeOptions = {}): HwpxEncodeResult {
  const originalParts = readZip(hwpx);
  const headerXml = tryPartToText(originalParts, HEADER_PART);
  const palette = opts.palette ?? buildPaletteFromHwpx(headerXml);
  const charMarks = parseCharMarks(headerXml);

  const sectionPaths = listSectionPaths(originalParts);
  if (sectionPaths.length === 0) throw new Error("HWPX: Contents/section*.xml 본문을 찾을 수 없음");

  const store: Store = { props: {}, frozen: {}, pSeq: 0, rSeq: 0, frunSeq: 0, tblSeq: 0 };
  const blocks: Block[] = [];

  sectionPaths.forEach((path, si) => {
    if (si > 0) {
      // 섹션 경계 마커: decode 가 여기서 섹션을 분리한다(어느 본문에도 포함되지 않음).
      blocks.push({ type: "frozen", refId: `secbound-${si}`, label: "[섹션 경계]" });
    }
    const secRoot = findSectionRoot(parseXml(partToText(originalParts, path)));
    for (const p of findParagraphs(secRoot)) {
      // 편집 가능 표: 표를 품은 문단은 Table 블록으로 승격(원본 hp:p 보존, 셀만 채움 슬롯).
      if (opts.editableTables && findDeep([p], "hp:tbl") !== undefined) {
        blocks.push(hwpxTableBlock(p, palette, store));
      } else {
        blocks.push(paragraphToBlock(p, palette, charMarks, store));
      }
    }
  });

  const model: DocModel = { blocks };
  const manifest: Manifest = {
    version: 1,
    format: "hwpx",
    container: "zip",
    originalParts,
    frozen: store.frozen,
    props: store.props,
    paletteId: palette.id,
    native: { sectionPaths: JSON.stringify(sectionPaths) },
  };
  const html = serializeModelToHtml(model, palette);
  return { html, manifest, model };
}

function paragraphToBlock(
  p: import("../core/xml.js").XmlNode,
  palette: Palette,
  charMarks: Map<string, Mark[]>,
  store: Store,
): Block {
  const styleKey = styleKeyFromDocxId(palette, readParaStyleRef(p));
  const htmlTag = htmlTagFromStyleKey(palette, styleKey);

  const attrs = attrsOf(p);
  let propsRef: string | undefined;
  if (Object.keys(attrs).length > 0) {
    propsRef = `pp-${store.pSeq++}`;
    store.props[propsRef] = JSON.stringify(attrs);
  }

  const runs: Run[] = readRuns(p).map((r) => {
    if (r.frozenXml) {
      const token = `frun-${store.frunSeq++}`;
      store.frozen[token] = r.frozenXml;
      return { text: "", frozenRef: token, label: r.frozenLabel ?? "[개체]" };
    }
    const run: Run = { text: r.text };
    const marks = r.charPrRef !== undefined ? charMarks.get(r.charPrRef) : undefined;
    if (marks && marks.length) run.marks = [...marks];
    if (r.charPrRef !== undefined) {
      const token = `rp-${store.rSeq++}`;
      store.props[token] = r.charPrRef;
      run.propsRef = token;
    }
    return run;
  });

  if (/^h[1-6]$/.test(htmlTag)) {
    const level = Number(htmlTag.slice(1)) as 1 | 2 | 3 | 4 | 5 | 6;
    return { type: "heading", level, styleKey, runs, propsRef };
  }
  if (htmlTag === "li") {
    return { type: "listItem", ordered: false, level: 0, styleKey, runs, propsRef };
  }
  return { type: "paragraph", styleKey, runs, propsRef };
}

/**
 * 표를 품은 hp:p → 편집 가능 Table 블록. 원본 hp:p 통째를 frozen 에 보존(sourceRef)하고,
 * 각 셀엔 cellRef + 평문 텍스트만 담는다. decode 가 바뀐 셀의 hp:t 만 갈아끼워 표 서식을 보존한다.
 */
function hwpxTableBlock(p: XmlNode, palette: Palette, store: Store): Table {
  const sourceRef = `htbl-${store.tblSeq++}`;
  store.frozen[sourceRef] = buildXml([p]);
  const tbl = findDeep([p], "hp:tbl");
  const rows: TableRow[] = [];
  if (tbl) {
    findChildren(childrenOf(tbl), "hp:tr").forEach((tr, r) => {
      const cells: TableCell[] = [];
      findChildren(childrenOf(tr), "hp:tc").forEach((tc, c) => {
        let colSpan: number | undefined, rowSpan: number | undefined;
        const span = findChild(childrenOf(tc), "hp:cellSpan");
        if (span) {
          const cs = Number(attrOf(span, "colSpan"));
          const rs = Number(attrOf(span, "rowSpan"));
          if (Number.isFinite(cs) && cs > 1) colSpan = cs;
          if (Number.isFinite(rs) && rs > 1) rowSpan = rs;
        }
        cells.push({ styleKey: palette.fallbackStyleKey, blocks: [], cellRef: `${sourceRef}:${r}:${c}`, text: deepText(tc), colSpan, rowSpan });
      });
      rows.push({ cells });
    });
  }
  return { type: "table", styleKey: palette.fallbackStyleKey, rows, sourceRef };
}
