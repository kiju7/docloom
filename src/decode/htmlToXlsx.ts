/**
 * decode: 편집된 HTML + Manifest → xlsx
 *
 * 파이프라인
 *   1) HTML 파싱 → 각 data-cell(="Sheet!A1") 의 새 텍스트를 읽는다.
 *   2) 시트별로, 변경된 셀의 원본 <c> 를 inlineStr 로 교체한다.
 *        <c r=".." t="inlineStr" s="원본스타일"><is><t xml:space="preserve">text</t></is></c>
 *      이때 원본 s(스타일 index)는 그대로 보존한다(서식 유지).
 *   3) 그 외 모든 part(스타일·병합·이미지·rels…)는 originalParts 에서 손대지 않고 복사.
 *   4) writeZip 으로 다시 묶는다.
 *
 * 원칙: 콘텐츠(셀 텍스트)만 재생성. 골격은 바이트 그대로.
 */
import type { Manifest } from "../model/manifest.js";
import { writeZip, partToText, tryPartToText, textToPart } from "../core/zip.js";
import {
  parseXml,
  buildXml,
  collectDeep,
  childrenOf,
  findChild,
  findChildren,
  attrOf,
  deepText,
  setChildren,
  type XmlNode,
} from "../core/xml.js";

export interface XlsxDecodeOptions {
  _reserved?: never;
}

/** 워크북에서 시트 이름 → 경로 매핑(순서 기준). */
function sheetNameToPath(parts: Record<string, Uint8Array>): Map<string, string> {
  const wb = tryPartToText(parts, "xl/workbook.xml");
  const names: string[] = [];
  if (wb) for (const s of collectDeep(parseXml(wb), "sheet")) names.push(attrOf(s, "name") ?? `Sheet${names.length + 1}`);
  const paths = Object.keys(parts)
    .filter((p) => /^xl\/worksheets\/sheet\d+\.xml$/.test(p))
    .sort((a, b) => sheetNum(a) - sheetNum(b));
  const map = new Map<string, string>();
  paths.forEach((path, i) => map.set(names[i] ?? `Sheet${i + 1}`, path));
  return map;
}
const sheetNum = (p: string): number => Number(/sheet(\d+)\.xml$/.exec(p)?.[1] ?? 0);

/** 편집 HTML → { "Sheet!A1": 텍스트 } 맵 (셀 단위 평탄화). */
function readEditedCells(html: string): Map<string, string> {
  const tree = parseXml(html);
  const out = new Map<string, string>();
  for (const td of collectDeep(tree, "td")) {
    const addr = attrOf(td, "data-cell");
    if (!addr) continue;
    out.set(addr, deepText(td));
  }
  return out;
}

/** 한 시트 XML 의 셀들을 편집값으로 갱신해 새 XML 문자열 반환. */
function updateSheetXml(
  xml: string,
  sheetName: string,
  edited: Map<string, string>,
  original: Map<string, string>,
): string {
  const tree = parseXml(xml);
  for (const c of collectDeep(tree, "c")) {
    const ref = attrOf(c, "r");
    if (!ref) continue;
    const addr = `${sheetName}!${ref}`;
    if (!edited.has(addr)) continue;
    const newText = edited.get(addr)!;
    // 변경 없으면 원본 셀을 그대로 둔다(숫자/수식 등 손대지 않음).
    if (newText === (original.get(addr) ?? "")) continue;
    rewriteCellAsInlineStr(c, newText);
  }
  return buildXml(tree);
}

/** <c> 를 inlineStr 로 다시 쓴다 — r 과 s(스타일)는 보존, 값만 교체. */
function rewriteCellAsInlineStr(c: XmlNode, text: string): void {
  const attrs = (c[":@"] as Record<string, unknown> | undefined) ?? {};
  const r = attrs["@_r"];
  const s = attrs["@_s"];
  const newAttrs: Record<string, unknown> = {};
  if (r !== undefined) newAttrs["@_r"] = r;
  newAttrs["@_t"] = "inlineStr";
  if (s !== undefined) newAttrs["@_s"] = s;
  c[":@"] = newAttrs;

  const tNode: XmlNode = { "#text": text };
  // xml:space="preserve" 로 앞뒤 공백 보존
  const t: XmlNode = { t: [tNode], ":@": { "@_xml:space": "preserve" } };
  const is: XmlNode = { is: [t] };
  setChildren(c, [is]);
}

/** sharedStrings.xml → 문자열 배열(원본 텍스트 비교용). */
function readSharedStrings(parts: Record<string, Uint8Array>): string[] {
  const xml = tryPartToText(parts, "xl/sharedStrings.xml");
  if (!xml) return [];
  return collectDeep(parseXml(xml), "si").map((si) =>
    collectDeep([si], "t").map(deepText).join(""),
  );
}

/** 원본 시트의 주소→텍스트 맵(변경 여부 판정용). */
function originalCellTexts(xml: string, sheetName: string, shared: string[]): Map<string, string> {
  const tree = parseXml(xml);
  const out = new Map<string, string>();
  for (const row of collectDeep(tree, "row")) {
    for (const c of findChildren(childrenOf(row), "c")) {
      const ref = attrOf(c, "r");
      if (!ref) continue;
      const type = attrOf(c, "t");
      const v = findChild(childrenOf(c), "v");
      const isNode = findChild(childrenOf(c), "is");
      let text = "";
      if (type === "s" && v) text = shared[Number(deepText(v))] ?? "";
      else if (type === "inlineStr" && isNode) text = deepText(isNode);
      else if (v) text = deepText(v);
      else if (isNode) text = deepText(isNode);
      out.set(`${sheetName}!${ref}`, text);
    }
  }
  return out;
}

export function decodeHtmlToXlsx(html: string, manifest: Manifest, _opts: XlsxDecodeOptions = {}): Uint8Array {
  const originalParts = manifest.originalParts;
  const shared = readSharedStrings(originalParts);
  const edited = readEditedCells(html);
  const nameToPath = sheetNameToPath(originalParts);

  // 편집된 셀을 시트별로 묶고, 변경된 시트만 XML 재생성.
  const parts: Record<string, Uint8Array> = { ...originalParts };

  for (const [sheetName, path] of nameToPath) {
    const xml = partToText(originalParts, path);
    const original = originalCellTexts(xml, sheetName, shared);
    // 이 시트에 편집값이 하나라도 있으면 갱신 시도
    const hasEdit = [...edited.keys()].some((k) => k.startsWith(`${sheetName}!`));
    if (!hasEdit) continue;
    const newXml = updateSheetXml(xml, sheetName, edited, original);
    parts[path] = textToPart(newXml);
  }

  return writeZip(parts);
}
