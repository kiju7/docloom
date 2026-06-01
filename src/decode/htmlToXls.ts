/**
 * decode: 편집된 HTML + Manifest → xls(BIFF8/CFB) 바이트.
 *
 * 전략(docloom 철학): 원본 .xls 를 통째로 다시 읽고(readCfb), Workbook/Book 스트림의
 * 텍스트 셀 레코드만 인라인 LABEL(0x0204)로 갈아끼운다. 나머지 스트림은 byte-for-byte
 * 보존된다.
 *
 * LABELSST→LABEL 인라인 치환:
 *   편집된 텍스트 셀은 SST 를 건드리지 않고, 그 셀 레코드 자체를 LABEL(0x0204)로 재작성한다.
 *     data = [row u16][col u16][ixfe u16][XLUnicodeString]
 *   ixfe 는 원래 LABELSST/LABEL 의 XF index 를 그대로 유지 → 셀 스타일 보존.
 *
 * BOUNDSHEET lbPlyPos 보정(중요):
 *   레코드 길이가 바뀌면 각 시트 substream 의 BOF 절대 오프셋이 밀린다. BOUNDSHEET(0x0085)
 *   의 lbPlyPos(data offset 0, u32)는 그 절대 오프셋을 가리키므로, 재직렬화 후 각 시트
 *   BOF 의 새 오프셋을 찾아 패치한다. lbPlyPos 는 고정 4B 라 이 2차 패스는 길이를 안 바꾼다.
 */
import { parse } from "node-html-parser";
import type { Manifest } from "../model/manifest.js";
import { readCfb, writeCfb } from "../core/cfb.js";
import { XLS_SOURCE_KEY } from "../encode/xlsToHtml.js";
import {
  splitRecords,
  serializeRecord,
  writeXLUnicodeString,
  parseA1,
  readShortUnicode,
  REC_BOF,
  REC_BOUNDSHEET,
  REC_LABELSST,
  REC_LABEL,
  type BiffRecord,
} from "../formats/xls-biff.js";

/** 편집 결과: (sheetIdx, row, col) → 새 텍스트. */
interface Edit {
  sheetIdx: number;
  row: number;
  col: number;
  text: string;
}

/** 편집된 HTML 에서 텍스트 셀(data-cell, data-ro 없음)을 수집. */
function collectEdits(html: string): Map<string, Edit> {
  const root = parse(html, { blockTextElements: { script: false, style: false } });
  const edits = new Map<string, Edit>();
  for (const td of root.querySelectorAll("td[data-cell]")) {
    if (td.hasAttribute("data-ro")) continue; // 숫자/수식: 건너뜀
    const key = td.getAttribute("data-cell");
    if (!key) continue;
    const bang = key.indexOf("!");
    if (bang < 0) continue;
    const sheetIdx = parseInt(key.slice(0, bang), 10);
    const addr = key.slice(bang + 1);
    if (!Number.isFinite(sheetIdx)) continue;
    const rc = parseA1(addr);
    if (!rc) continue;
    // node-html-parser textContent + HTML 엔티티 디코드.
    const text = decodeEntities(td.textContent ?? "");
    edits.set(`${sheetIdx},${rc.row},${rc.col}`, { sheetIdx, row: rc.row, col: rc.col, text });
  }
  return edits;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * 워크북 스트림에서 시트 index → BOF substream 헤더 오프셋 매핑.
 * BOUNDSHEET 는 글로벌 substream 에 등장 순서대로 시트 0,1,2… 를 의미한다.
 * 워크시트 substream 의 BOF(0x0809, dt=worksheet) 들도 등장 순서가 시트 순서와 같다.
 */
function findSheetBofOffsets(records: BiffRecord[]): number[] {
  // 첫 BOF(글로벌) 이후의 BOF 들이 시트 substream 시작이다.
  const bofs: number[] = [];
  for (let i = 0; i < records.length; i++) {
    const rec = records[i]!;
    if (rec.type === REC_BOF) bofs.push(rec.offset - 4); // 레코드 헤더 절대 오프셋
  }
  // bofs[0] 은 글로벌, 나머지가 시트들.
  return bofs.slice(1);
}

export function decodeHtmlToXls(html: string, manifest: Manifest, _opts?: Record<string, unknown>): Uint8Array {
  const original = manifest.originalParts[XLS_SOURCE_KEY];
  if (!original) throw new Error(`[docloom] xls decode: manifest 에 원본 바이트(${XLS_SOURCE_KEY})가 없습니다.`);

  const cfb = readCfb(original);
  const wbPath = cfb.pathOf.has("Workbook") ? "Workbook" : cfb.pathOf.has("Book") ? "Book" : undefined;
  if (!wbPath) throw new Error("[docloom] xls decode: Workbook/Book 스트림을 찾지 못했습니다.");
  const wbIdx = cfb.pathOf.get(wbPath)!;
  const wbBytes = cfb.data.get(wbIdx);
  if (!wbBytes) throw new Error("[docloom] xls decode: Workbook 스트림 데이터를 찾지 못했습니다.");

  const edits = collectEdits(html);
  const records = splitRecords(wbBytes);

  // 시트 index 매핑: 글로벌 substream 의 BOUNDSHEET 등장 순서 = 시트 index.
  // 셀 레코드가 어느 시트에 속하는지는 substream BOF 오프셋으로 판정한다.
  const sheetBofs = sheetBofOffsetsByOrder(records);

  // 각 셀 레코드의 절대 헤더 오프셋이 속한 시트 index.
  const sheetIndexAt = (headerOff: number): number => {
    let found = -1;
    for (let i = 0; i < sheetBofs.length; i++) {
      if (headerOff >= sheetBofs[i]!) found = i;
      else break;
    }
    return found;
  };

  // 1) 텍스트 셀(LABELSST/LABEL) 중 편집된 것을 인라인 LABEL 로 재작성하며 재직렬화.
  const outRecords: Uint8Array[] = [];
  for (const rec of records) {
    const headerOff = rec.offset - 4;
    if (rec.type === REC_LABELSST || rec.type === REC_LABEL) {
      const dv = new DataView(rec.data.buffer, rec.data.byteOffset, rec.data.byteLength);
      const row = dv.getUint16(0, true);
      const col = dv.getUint16(2, true);
      const ixfe = dv.getUint16(4, true);
      const si = sheetIndexAt(headerOff);
      const edit = si >= 0 ? edits.get(`${si},${row},${col}`) : undefined;
      if (edit !== undefined) {
        // 원래 텍스트와 같으면 굳이 바꾸지 않는다(LABELSST 는 그대로 두는 게 안전).
        const oldText =
          rec.type === REC_LABEL ? readShortUnicode(rec.data, 8, dv.getUint16(6, true)) : null;
        if (rec.type === REC_LABEL && oldText === edit.text) {
          outRecords.push(serializeRecord(rec.type, rec.data));
          continue;
        }
        // LABEL 레코드 작성: [row][col][ixfe][XLUnicodeString].
        const us = writeXLUnicodeString(edit.text);
        const data = new Uint8Array(6 + us.length);
        const ddv = new DataView(data.buffer);
        ddv.setUint16(0, row, true);
        ddv.setUint16(2, col, true);
        ddv.setUint16(4, ixfe, true);
        data.set(us, 6);
        outRecords.push(serializeRecord(REC_LABEL, data));
        continue;
      }
    }
    // 그 외 모든 레코드(숫자/수식/구조)는 원본 그대로.
    outRecords.push(serializeRecord(rec.type, rec.data));
  }

  let newStream = concat(outRecords);

  // 2) BOUNDSHEET lbPlyPos 보정: 재직렬화된 스트림에서 시트 BOF 오프셋을 다시 찾아 패치.
  patchBoundsheetOffsets(newStream);

  cfb.data.set(wbIdx, newStream);
  return writeCfb({ entries: cfb.entries, data: cfb.data });
}

/** 글로벌 BOF 이후 BOF 들의 헤더 절대 오프셋(시트 순서대로). */
function sheetBofOffsetsByOrder(records: BiffRecord[]): number[] {
  return findSheetBofOffsets(records);
}

/**
 * 재직렬화된 워크북 스트림에서 BOUNDSHEET 들의 lbPlyPos 를 실제 시트 BOF 오프셋으로 패치.
 * BOUNDSHEET 등장 순서 = 시트 순서 = (글로벌 이후) BOF 등장 순서.
 */
function patchBoundsheetOffsets(stream: Uint8Array): void {
  const records = splitRecords(stream);
  const sheetBofs = findSheetBofOffsets(records); // 시트 0,1,2… 의 BOF 절대 오프셋
  let sheetSeq = 0;
  for (const rec of records) {
    if (rec.type !== REC_BOUNDSHEET) continue;
    const bof = sheetBofs[sheetSeq];
    if (bof !== undefined) {
      // rec.data 는 stream 의 subarray → 직접 쓰면 stream 에 반영된다.
      const dv = new DataView(rec.data.buffer, rec.data.byteOffset, rec.data.byteLength);
      dv.setUint32(0, bof, true); // lbPlyPos = data offset 0
    }
    sheetSeq++;
  }
}

function concat(chunks: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}
