/**
 * encode: .doc(Word 97-2003 바이너리, OLE2/CFB) → 편집용 HTML + Manifest
 *
 * docloom 철학: "원본 바이트는 보존하고, 편집된 콘텐츠만 재생성".
 *   - 원본 .doc 파일 전체 바이트를 manifest.originalParts["__source__"] 에 보관한다.
 *     (decode 는 이걸 readCfb → "WordDocument" 스트림만 패치 → writeCfb.)
 *   - "WordDocument" 의 raw 텍스트를 Table 스트림의 piece table(CLX) 순서로 읽어,
 *     각 piece 를 CR(0x0D)로 문단 분할해 편집 가능한 <p> 로 노출한다.
 *   - 각 문단은 안정 id `data-piece="<pieceIdx>:<paraIdx>"` 를 갖는다.
 *     decode 는 이 id 로 piece 안에서 어느 문단을 바꿀지 찾는다.
 *
 * 길이 보존 왕복 전략(decode 상세는 htmlToDoc.ts): 한 piece 의 전체 텍스트(문단 합)를
 *   같은 압축방식으로 재인코딩했을 때 바이트 길이가 같으면, WordDocument 의 그 piece
 *   바이트만 제자리 덮어쓴다 → piece table·FIB fc·CP 배열을 전혀 안 건드려도 된다.
 *
 * 미지원(정직하게): 서식 런(CHPX/PAPX)·필드·표·이미지·길이 변경 편집(piece table 재작성 필요).
 */
import type { Manifest } from "../model/manifest.js";
import { readCfb } from "../core/cfb.js";
import { toPreviewHtml, type PreviewOptions } from "../preview/preview.js";
import { parseFib, parsePieceTable, readPieceText, type Piece } from "../formats/doc-fib.js";

/** 원본 .doc 컨테이너 바이트를 manifest.originalParts 에 담는 키. */
export const DOC_SOURCE_KEY = "__source__";
/** 메인 스트림 경로(CFB 내 명명 스트림). */
export const DOC_MAIN_STREAM = "WordDocument";

export interface DocEncodeResult {
  html: string;
  manifest: Manifest;
}

/** piece 의 원시 텍스트(제어문자 포함)에서 piece 안 문단 id 를 만든다. */
export function pieceParaId(pieceIdx: number, paraIdx: number): string {
  return `${pieceIdx}:${paraIdx}`;
}

/** Word 의 특수 종결문자(셀/행/문단 끝 표시 등) 중 표시상 제거할 잡문자 제거. */
function cleanDisplay(s: string): string {
  // 0x07(셀/행 끝), 0x0B(수동 줄바꿈)→\n, 0x0C(페이지나눔), 0x1E/0x1F(옵션 하이픈) 정리.
  return s.replace(/\x0b/g, "\n").replace(/\x00/g, "");
}

/** WordDocument + Table 에서 piece 별 원시 텍스트를 읽는다. */
export function readDocPieces(bytes: Uint8Array): {
  wordDocument: Uint8Array;
  pieces: Piece[];
  texts: string[];
} {
  const cfb = readCfb(bytes);
  const wordDocument = cfb.streams[DOC_MAIN_STREAM];
  if (!wordDocument) {
    throw new Error(`DOC: "${DOC_MAIN_STREAM}" 스트림을 찾지 못했습니다(Word 97-2003 아님).`);
  }
  const fib = parseFib(wordDocument);
  const table = cfb.streams[fib.tableStreamName];
  if (!table) {
    throw new Error(`DOC: Table 스트림 "${fib.tableStreamName}" 을 찾지 못했습니다.`);
  }
  const pieces = parsePieceTable(table, fib.fcClx, fib.lcbClx);
  const texts = pieces.map((p) => readPieceText(wordDocument, p));
  return { wordDocument, pieces, texts };
}

export function encodeDocToHtml(bytes: Uint8Array, _opts: PreviewOptions = {}): DocEncodeResult {
  const { pieces, texts } = readDocPieces(bytes);

  // 원본 piece 원시 텍스트(변경 여부 판단용)를 manifest 에 보관.
  const origText: Record<string, string> = {};
  for (let i = 0; i < pieces.length; i++) origText[String(i)] = texts[i]!;

  const html = renderEditableHtml(texts);

  const manifest: Manifest = {
    version: 1,
    format: "doc",
    container: "cfb",
    originalParts: { [DOC_SOURCE_KEY]: bytes },
    frozen: {},
    props: {},
    paletteId: "doc-binary",
    native: {
      // decode 가 piece 원본 텍스트를 비교할 수 있도록 보관.
      origText: JSON.stringify(origText),
      pieceCount: String(pieces.length),
    },
  };

  return { html, manifest };
}

/** piece 들을 CR(0x0D)로 문단 분할해 편집 가능한 <p data-piece> 로 만든다. */
function renderEditableHtml(texts: string[]): string {
  const paras: string[] = [];
  for (let pi = 0; pi < texts.length; pi++) {
    // CR(0x0D)=문단 끝. 마지막 CR 뒤 빈 조각은 버리지 않고 유지(편집 일관성).
    const segs = texts[pi]!.split("\r");
    // 마지막 segment 가 빈 문자열이고 CR 로 끝났으면(보통 그렇다) 표시상 제거.
    if (segs.length > 1 && segs[segs.length - 1] === "") segs.pop();
    for (let si = 0; si < segs.length; si++) {
      const disp = cleanDisplay(segs[si]!);
      const inner = disp.length ? esc(disp).replace(/\n/g, "<br>") : "";
      paras.push(`<p data-piece="${esc(pieceParaId(pi, si))}">${inner}</p>`);
    }
  }
  const body = paras.length ? paras.join("\n") : `<p>편집할 텍스트를 찾지 못했습니다.</p>`;
  return `<div class="doc-wrap docloom-doc">${body}</div>`;
}

/** 미리보기와 같은 스타일을 입혀 완결 HTML 을 만든다(편집 UI 겸용). */
export function docEditableDocument(bytes: Uint8Array, opts: PreviewOptions = {}): string {
  const { html } = encodeDocToHtml(bytes, opts);
  return toPreviewHtml(html, opts);
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
