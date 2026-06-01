/**
 * doc 포맷 어댑터 — Word 97-2003 바이너리(.doc, OLE2/CFB)의 미리보기 + 왕복.
 *
 * .doc 는 zip 이 아니라 OLE2/CFB 복합문서다. 본문 텍스트는 "WordDocument" 스트림에 raw 로
 * 들어있지만, 논리 문자순서(CP)→파일오프셋(FC) 매핑은 Table 스트림("1Table"/"0Table")의
 * **piece table(CLX)** 가 정의한다(FIB → fcClx/lcbClx). 각 piece 는 압축(cp1252 1B/char)
 * 또는 비압축(UTF-16LE 2B/char)이다. 자세한 파서는 doc-fib.ts 참고.
 *
 * 추출/편집 대상(부분 충실도): piece table 순서의 본문 텍스트(문단=CR 0x0D 분할).
 *
 * 왕복 전략: 길이 보존 in-place 패치(encode/decode 상세는 docToHtml.ts/htmlToDoc.ts).
 *   같은 문자 수(같은 압축 기준 같은 바이트 길이) 편집은 WordDocument 의 piece 바이트만
 *   제자리 덮어써 piece table·FIB·타 스트림을 전혀 안 건드린다. 길이 변경 편집은 거부.
 *
 * 한계(아직 미지원, 정직하게):
 *   - 길이가 바뀌는 편집(문자 추가/삭제) — piece table·FIB·서식 plex 오프셋 재작성 필요.
 *   - 서식 런(CHPX/PAPX·grpprl)·필드(field)·표·이미지·머리말/꼬리말/각주 구분·스타일.
 *   - cp1252 압축 piece 는 cp1252 표현 가능한 문자만 편집 가능.
 */
import type { FormatAdapter } from "../core/format.js";
import type { Manifest } from "../model/manifest.js";
import { toPreviewHtml, toPagedHtml, type PreviewOptions } from "../preview/preview.js";
import { readDocPieces } from "../encode/docToHtml.js";
import { encodeDocToHtml } from "../encode/docToHtml.js";
import { decodeHtmlToDoc } from "../decode/htmlToDoc.js";
import { renderDocResult } from "../preview/docRender.js";

/** piece 텍스트의 제어문자 정리(평문 폴백용). */
function cleanText(s: string): string {
  return s.replace(/\x0b/g, "\n").replace(/\x00/g, "").replace(/\x07/g, "");
}

/** doc 전용 미리보기 스타일(탭/TOC 점선 리더, 표 등). */
const DOC_CSS = `
.doc-tab { display:inline-block; min-width:18px; }
.doc-leader { flex:1 1 auto; border-bottom:1px dotted #999; margin:0 6px; transform:translateY(-3px); }
.doc-list-num { white-space:nowrap; }
.doc-shape-box, .doc-shape-line { box-sizing:border-box; }
`;

export function docToPreviewHtml(bytes: Uint8Array, opts: PreviewOptions = {}): string {
  // 1차: 서식·표·페이지를 복원하는 리치 렌더러(CHPX/PAPX/스타일 + 자동 페이지분할).
  try {
    const result = renderDocResult(bytes);
    return toPagedHtml(result, { title: opts.title, typographyCss: (opts.css ?? "") + DOC_CSS });
  } catch {
    // 2차: 서식 파싱 실패 시 평문 폴백(텍스트라도 보여준다).
    return plainTextFallback(bytes, opts);
  }
}

/** 서식 파싱 실패 시 텍스트만이라도 보여주는 폴백. */
function plainTextFallback(bytes: Uint8Array, opts: PreviewOptions): string {
  let texts: string[];
  try {
    ({ texts } = readDocPieces(bytes));
  } catch (e) {
    return toPreviewHtml(
      `<div class="doc-wrap"><p>이 .doc 를 해석하지 못했습니다: ${esc(String(e instanceof Error ? e.message : e))}</p></div>`,
      opts,
    );
  }
  const all = texts.join("");
  const paras = all
    .split("\r")
    .map((p) => cleanText(p).trim())
    .filter((p) => p.length > 0);
  const body = paras.length
    ? paras.map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`).join("\n")
    : `<div class="doc-wrap"><p>표시할 텍스트를 찾지 못했습니다(이미지/표만 있을 수 있음).</p></div>`;
  const css = `\n  .docloom-doc p { margin: 0 0 8pt; font-size: 11pt; line-height: 1.7; }\n  `;
  return toPreviewHtml(`<div class="doc-wrap docloom-doc">${body}</div>`, {
    ...opts,
    css: (opts.css ?? "") + css,
  });
}

export const docAdapter: FormatAdapter = {
  id: "doc",
  label: "Word 97-2003 문서 (.doc)",
  // 왕복 지원: 길이 보존 편집(piece 바이트 제자리 패치). 길이 변경은 거부.
  supportsRoundTrip: true,
  /** CFB 라우팅은 컨테이너로 한다(parts 기반 아님) → false. */
  detect() {
    return false;
  },
  encode(bytes, opts) {
    return encodeDocToHtml(bytes, (opts ?? {}) as PreviewOptions);
  },
  decode(html, manifest, opts) {
    return decodeHtmlToDoc(html, manifest as Manifest, opts ?? {});
  },
  toPreviewHtml(bytes, opts) {
    return docToPreviewHtml(bytes, (opts ?? {}) as PreviewOptions);
  },
};

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
