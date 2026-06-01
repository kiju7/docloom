/**
 * encode: .ppt(PowerPoint 97-2003 바이너리, OLE2/CFB) → 편집용 HTML + Manifest
 *
 * docloom 철학: "원본 바이트는 보존하고, 편집된 콘텐츠만 재생성".
 *   - 원본 .ppt 파일 전체 바이트를 manifest.originalParts["__source__"] 에 보관한다.
 *     (decode 는 이걸 readCfb → "PowerPoint Document" 스트림만 패치 → writeCfb 한다.)
 *   - "PowerPoint Document" 스트림의 텍스트 atom(TextChars/TextBytes)을 등장 순서로
 *     수집해, 슬라이드 카드로 묶어 편집 가능한 HTML 로 노출한다.
 *   - 각 텍스트 atom 은 안정 id 를 data-atom 속성으로 갖는다.
 *     id 형식: "<headerOffset>:<recType>:<order>" — 절대 헤더 오프셋·타입·등장순서.
 *     decode 는 이 id 로 어느 atom 을 바꿀지 정확히 찾는다.
 *   - 서식(런/문단)은 별도 레코드(StyleTextPropAtom 등)에 있고 건드리지 않으므로,
 *     텍스트 atom 문자 바이트만 갈아끼우면 서식은 자동 보존된다.
 *
 * 전략(decode 측 상세는 htmlToPpt.ts): 길이 보존 in-place 패치(전략 A) — 같은 문자 수
 * 편집은 같은 바이트 길이라 persist-directory 오프셋이 전혀 안 바뀐다. 길이가 바뀌는
 * 편집은 decode 가 persist 오프셋을 재계산해 처리(전략 B, 베스트에포트).
 */
import type { Manifest } from "../model/manifest.js";
import { readCfb } from "../core/cfb.js";
import { toPreviewHtml, type PreviewOptions } from "../preview/preview.js";
import { collectTextAtoms, type TextAtomLoc } from "../formats/ppt-records.js";

/** 원본 .ppt 컨테이너 바이트를 manifest.originalParts 에 담는 키. */
export const PPT_SOURCE_KEY = "__source__";
/** "PowerPoint Document" 스트림 경로(CFB 내 명명 스트림). */
export const PPT_DOC_STREAM = "PowerPoint Document";

export interface PptEncodeResult {
  html: string;
  manifest: Manifest;
}

/** atom 의 안정 id(decode 가 다시 찾는 키). */
export function atomId(loc: { headerOffset: number; recType: number; order: number }): string {
  return `${loc.headerOffset}:${loc.recType}:${loc.order}`;
}

/** PPT 텍스트의 제어문자를 편집용 표시 텍스트로 정리(CR/VT → \n, NUL 제거). */
function displayText(s: string): string {
  return s.replace(/\r/g, "\n").replace(/\x0b/g, "\n").replace(/\x00/g, "");
}

export function encodePptToHtml(bytes: Uint8Array, _opts: PreviewOptions = {}): PptEncodeResult {
  const cfb = readCfb(bytes);
  const docBytes = cfb.streams[PPT_DOC_STREAM];
  if (!docBytes) {
    throw new Error(`PPT: "${PPT_DOC_STREAM}" 스트림을 찾지 못했습니다(PowerPoint 97-2003 아님).`);
  }

  const atoms = collectTextAtoms(docBytes);

  // 원본 텍스트(원시, 제어문자 포함)를 manifest 에 보관 → decode 가 "변경 여부" 판단.
  const origText: Record<string, string> = {};
  for (const a of atoms) origText[atomId(a)] = a.text;

  // 슬라이드 그룹핑(미리보기와 동일한 근사): slideIndex 별로 묶는다.
  const html = renderEditableHtml(atoms);

  const manifest: Manifest = {
    version: 1,
    format: "ppt",
    container: "cfb",
    originalParts: { [PPT_SOURCE_KEY]: bytes },
    frozen: {},
    props: {},
    paletteId: "ppt-binary",
    native: {
      // decode 가 atom 원본 텍스트를 비교할 수 있도록 보관.
      origText: JSON.stringify(origText),
      atomCount: String(atoms.length),
    },
  };

  return { html, manifest };
}

/** 텍스트 atom 들을 슬라이드 카드로 묶어 편집 가능한 HTML 본문을 만든다. */
function renderEditableHtml(atoms: TextAtomLoc[]): string {
  // slideIndex(>=0) 별로 그룹. -1(슬라이드 밖: 마스터/타이틀 등)은 별도 선두 그룹.
  const groups = new Map<number, TextAtomLoc[]>();
  const order: number[] = [];
  for (const a of atoms) {
    if (!groups.has(a.slideIndex)) {
      groups.set(a.slideIndex, []);
      order.push(a.slideIndex);
    }
    groups.get(a.slideIndex)!.push(a);
  }

  const cards: string[] = [];
  let slideNo = 0;
  for (const gi of order) {
    const list = groups.get(gi)!;
    const items = list
      .map((a) => {
        const id = esc(atomId(a));
        const disp = displayText(a.text);
        // 빈 문자열도 편집 가능하도록 유지(공백 자리표시). data-atom 으로 추적.
        const inner = disp.length ? esc(disp).replace(/\n/g, "<br>") : "";
        return `<p data-atom="${id}">${inner}</p>`;
      })
      .join("");
    const label = gi >= 0 ? `슬라이드 ${++slideNo}` : "공통(슬라이드 외)";
    cards.push(`<div class="ppt-slide-no">${esc(label)}</div><section class="ppt-slide">${items}</section>`);
  }

  const body = cards.length
    ? cards.join("\n")
    : `<div class="ppt-wrap"><p>편집할 텍스트를 찾지 못했습니다.</p></div>`;
  return `<div class="ppt-wrap">${body}</div>`;
}

/** 미리보기와 같은 카드 스타일을 입혀 완결 HTML 을 만든다(편집 UI 겸용). */
export function pptEditableDocument(bytes: Uint8Array, opts: PreviewOptions = {}): string {
  const { html } = encodePptToHtml(bytes, opts);
  const css = `
  body { padding: 24px; background:#eceef0; }
  .ppt-slide-no { font-size:12px; color:#6b7280; margin:18px auto 6px; max-width:720px; }
  .ppt-slide { max-width:720px; margin:0 auto 8px; padding:28px 32px; background:#fff;
    border-radius:8px; box-shadow:0 1px 4px rgba(0,0,0,.12), 0 8px 24px rgba(0,0,0,.08); }
  .ppt-slide p { margin:0 0 8px; font-size:14px; line-height:1.6; color:#1a1a1a; }
  .ppt-slide p:first-child { font-size:20px; font-weight:700; margin-bottom:14px; }
  `;
  return toPreviewHtml(html, { ...opts, css: (opts.css ?? "") + css });
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
