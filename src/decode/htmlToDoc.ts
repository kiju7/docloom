/**
 * decode: 편집된 HTML + Manifest → .doc(Word 97-2003 바이너리, OLE2/CFB)
 *
 * ── 채택 전략: 길이 보존 in-place 패치(LOW RISK, 1급이자 유일 경로) ───────────
 *   편집된 한 piece 의 "전체 텍스트"(piece 안 문단들을 CR 로 재결합)를 그 piece 의
 *   원래 압축방식(cp1252 1B/char 또는 UTF-16LE 2B/char)으로 재인코딩했을 때
 *   **원본 piece 와 같은 바이트 길이**면, WordDocument 스트림의 그 piece 바이트만
 *   제자리(FC 위치) 덮어쓴다.
 *     → piece table(CLX)·FIB 의 fc 필드·CP 배열·다른 스트림이 전혀 안 바뀐다.
 *     → 재-readCfb / 재-parse 가 손상 없이 동작하고, 미편집 piece·서식·표·이미지는
 *       원본 바이트 그대로 보존된다.
 *
 * ── 길이 변경 편집: 기본 거부(HIGH RISK / 범위 밖) ────────────────────────────
 *   문자 수가 바뀌면 piece 의 바이트 길이가 바뀐다. 그러면 piece table 의 CP 배열·
 *   PCD 의 fc, 그리고 FIB 의 fcMac·여러 fc/lcb 필드, 나아가 텍스트 뒤에 오는
 *   서식 plex(grpprl) 들의 오프셋까지 일관되게 재작성해야 한다. 이는 손상 위험이 높아
 *   이번 범위에서 제외한다. 길이 변경 편집은 명확한 에러로 거부한다.
 *
 * 서식 보존: 서식(CHPX/PAPX·필드·표·이미지)은 모두 손대지 않는 다른 바이트 영역에 있고,
 *   piece 바이트만 같은 길이로 덮어쓰므로 그 오프셋이 그대로 유지되어 자동 보존된다.
 */
import { parse } from "node-html-parser";
import type { Manifest } from "../model/manifest.js";
import { readCfb, writeCfb } from "../core/cfb.js";
import { parseFib, parsePieceTable, readPieceText, encodePieceText, type Piece } from "../formats/doc-fib.js";
import { DOC_SOURCE_KEY, DOC_MAIN_STREAM } from "../encode/docToHtml.js";

/** HTML 의 data-piece 별 편집 텍스트 추출(<br>→\n, 엔티티 디코드). */
function readEditedParas(html: string): Map<string, string> {
  const root = parse(html, { lowerCaseTagName: true, comment: false });
  const out = new Map<string, string>();
  for (const el of root.querySelectorAll("[data-piece]")) {
    const id = el.getAttribute("data-piece");
    if (id === undefined) continue;
    let inner = el.innerHTML;
    inner = inner.replace(/<br\s*\/?>/gi, "\n");
    const tmp = parse(`<x>${inner}</x>`);
    const text = decodeEntities(tmp.querySelector("x")?.text ?? "");
    out.set(id, text);
  }
  return out;
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
 * 편집된 문단들을 piece 별로 묶어, 원본 piece 텍스트의 구조(문단 수·후행 CR)를 유지하며
 * 새 piece 전체 텍스트를 재구성한다.
 *
 * 원본 piece 텍스트를 CR 로 split 했을 때의 segment 구조를 그대로 재현한다:
 *   - 편집 HTML 에는 후행 빈 segment(마지막 CR 뒤)가 <p> 로 노출되지 않으므로,
 *     원본이 CR 로 끝났으면(후행 빈 segment 존재) 재결합 시 후행 CR 을 복원한다.
 */
function rebuildPieceText(origPieceText: string, edited: Map<string, string>, pieceIdx: number): string {
  const origSegs = origPieceText.split("\r");
  const trailingEmpty = origSegs.length > 1 && origSegs[origSegs.length - 1] === "";
  const visibleCount = trailingEmpty ? origSegs.length - 1 : origSegs.length;

  const segs: string[] = [];
  for (let si = 0; si < visibleCount; si++) {
    const key = `${pieceIdx}:${si}`;
    const e = edited.get(key);
    // 편집 HTML 에서 \n(수동 줄바꿈, 원본 0x0B)을 0x0B 로 되돌린다.
    const seg = (e ?? origSegs[si] ?? "").replace(/\n/g, "\x0b");
    segs.push(seg);
  }
  let text = segs.join("\r");
  if (trailingEmpty) text += "\r";
  return text;
}

export interface DocDecodeOptions {
  /** 예약(향후 길이 변경 재배치용). 현재는 사용하지 않으며 길이 변경은 항상 거부. */
  allowRelayout?: boolean;
}

export function decodeHtmlToDoc(html: string, manifest: Manifest, _opts: DocDecodeOptions = {}): Uint8Array {
  const source = manifest.originalParts[DOC_SOURCE_KEY];
  if (!source) throw new Error("DOC manifest: 원본 컨테이너 바이트(__source__)가 없음");

  const cfb = readCfb(source);
  const wdIdx = cfb.pathOf.get(DOC_MAIN_STREAM);
  const wordDocument = wdIdx !== undefined ? cfb.data.get(wdIdx) : undefined;
  if (wdIdx === undefined || !wordDocument) {
    throw new Error(`DOC: "${DOC_MAIN_STREAM}" 스트림을 찾지 못했습니다.`);
  }

  const fib = parseFib(wordDocument);
  const table = cfb.streams[fib.tableStreamName];
  if (!table) throw new Error(`DOC: Table 스트림 "${fib.tableStreamName}" 을 찾지 못했습니다.`);
  const pieces = parsePieceTable(table, fib.fcClx, fib.lcbClx);

  const edited = readEditedParas(html);
  const origText: Record<string, string> = JSON.parse(manifest.native?.origText ?? "{}");

  // piece 별로 새 전체 텍스트 산출 → 변경된 piece 만 패치.
  interface Patch {
    piece: Piece;
    newBytes: Uint8Array;
  }
  const patches: Patch[] = [];

  for (let pi = 0; pi < pieces.length; pi++) {
    const piece = pieces[pi]!;
    const orig = origText[String(pi)] ?? readPieceText(wordDocument, piece);
    const rebuilt = rebuildPieceText(orig, edited, pi);
    if (rebuilt === orig) continue; // 변경 없음

    // 같은 압축방식으로 재인코딩.
    const newBytes = encodePieceText(rebuilt, piece.compressed);
    if (!newBytes) {
      throw new Error(
        `DOC piece ${pi}: 편집 텍스트를 ${piece.compressed ? "cp1252(압축)" : "UTF-16LE"} 로 무손실 인코딩할 수 없습니다. ` +
          `이 piece 는 해당 문자집합으로 표현 가능한 문자만 편집할 수 있습니다.`,
      );
    }
    // 길이 보존 검증: 같은 바이트 길이여야 in-place 패치 가능.
    if (newBytes.length !== piece.byteLength) {
      throw new Error(
        `DOC piece ${pi}: 길이가 바뀌는 편집은 지원하지 않습니다(원본 ${piece.byteLength}B → ${newBytes.length}B). ` +
          `piece table·FIB·서식 plex 오프셋 재작성이 필요해 범위에서 제외됩니다. ` +
          `같은 문자 수(같은 압축 기준 같은 바이트 길이)로만 편집하세요.`,
      );
    }
    patches.push({ piece, newBytes });
  }

  if (patches.length === 0) {
    // 변경 없음 → 원본 그대로 재조립.
    return writeCfb({ entries: cfb.entries, data: cfb.data });
  }

  // ── 길이 보존 in-place 패치: WordDocument 의 piece 바이트만 제자리 덮어쓰기 ──
  const newWd = wordDocument.slice();
  for (const p of patches) newWd.set(p.newBytes, p.piece.fcStart);

  cfb.data.set(wdIdx, newWd);
  return writeCfb({ entries: cfb.entries, data: cfb.data });
}
