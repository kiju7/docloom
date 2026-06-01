/**
 * ppt 포맷 어댑터 — PowerPoint 97-2003 바이너리(CFB)의 미리보기(읽기) 전용 구현.
 *
 * .ppt 는 zip 이 아니라 OLE2/CFB 복합문서다. 프레젠테이션 본문은 "PowerPoint Document"
 * 스트림에 MS-PPT 의 중첩 레코드 트리로 담긴다. 각 레코드 헤더(8B):
 *   [2B recVer/recInstance LE][2B recType LE][4B recLen LE]
 * recVer 의 하위 4bit 가 0xF 면 컨테이너(자식 레코드를 품음), 아니면 atom(원자).
 *
 * 이 어댑터가 추출하는 것(부분 충실도):
 *   - TextCharsAtom(0x0FA0): UTF-16LE 텍스트
 *   - TextBytesAtom(0x0FA8): ANSI/Latin1 텍스트(1바이트, 상위바이트 0 가정)
 *   텍스트 레코드들을 등장 순서로 모아 슬라이드/카드로 묶어 보여준다.
 *
 * 슬라이드 경계: 이 바이너리 포맷에서 텍스트→슬라이드 정확 매핑은 PersistDirectory·
 *   Slide 컨테이너 추적이 필요하다. 여기서는 근사로, Slide 컨테이너(0x03EE) 경계를 만나면
 *   카드를 나눈다. 컨테이너 경계가 안 잡히면 텍스트 atom 을 순서대로 한 흐름에 모은다.
 *
 * 한계(아직 미지원): 도형 위치/서식·표·이미지·노트/마스터 구분·정확한 슬라이드 매핑·왕복.
 */
import type { FormatAdapter } from "../core/format.js";
import type { Manifest } from "../model/manifest.js";
import { readCfb } from "../core/cfb.js";
import { toPreviewHtml, type PreviewOptions } from "../preview/preview.js";
import { encodePptToHtml } from "../encode/pptToHtml.js";
import { decodeHtmlToPpt } from "../decode/htmlToPpt.js";
import { pptToRichHtml } from "./pptRender.js";

// ── 레코드 타입 ──────────────────────────────────────────────────────────────
const REC_SLIDE = 0x03ee; // Slide 컨테이너
const REC_TEXTCHARS = 0x0fa0; // TextCharsAtom (UTF-16LE)
const REC_TEXTBYTES = 0x0fa8; // TextBytesAtom (ANSI 1B)

interface PptAtom {
  type: number;
  text: string;
}

/** "PowerPoint Document" 스트림 → 슬라이드별 텍스트 줄 묶음(근사). */
function parseTextBySlide(buf: Uint8Array): string[][] {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const atoms: PptAtom[] = [];
  /** Slide 컨테이너 헤더를 만난 atom 인덱스(슬라이드 경계). */
  const slideBoundaries: number[] = [];

  // 레코드 트리를 재귀 없이(스택) 순회. 컨테이너는 내부를 다시 파싱한다.
  const walk = (start: number, end: number): void => {
    let p = start;
    while (p + 8 <= end) {
      const verInst = dv.getUint16(p, true);
      const recType = dv.getUint16(p + 2, true);
      const recLen = dv.getUint32(p + 4, true);
      const bodyStart = p + 8;
      const bodyEnd = bodyStart + recLen;
      if (bodyEnd > end) break; // 잘린 꼬리 방어
      const isContainer = (verInst & 0x000f) === 0x000f;

      if (recType === REC_SLIDE) slideBoundaries.push(atoms.length);

      if (isContainer) {
        walk(bodyStart, bodyEnd);
      } else if (recType === REC_TEXTCHARS) {
        let s = "";
        for (let q = bodyStart; q + 1 < bodyEnd; q += 2) s += String.fromCharCode(dv.getUint16(q, true));
        atoms.push({ type: recType, text: cleanText(s) });
      } else if (recType === REC_TEXTBYTES) {
        let s = "";
        for (let q = bodyStart; q < bodyEnd; q++) s += String.fromCharCode(buf[q]!);
        atoms.push({ type: recType, text: cleanText(s) });
      }
      p = bodyEnd;
    }
  };
  walk(0, buf.length);

  // 슬라이드 경계로 텍스트 atom 을 그룹핑. 경계가 없으면 전체를 한 슬라이드로.
  if (slideBoundaries.length === 0) {
    const lines = atoms.map((a) => a.text).filter((t) => t.length > 0);
    return lines.length ? [lines] : [];
  }
  const slides: string[][] = [];
  // 첫 경계 이전 텍스트(마스터/타이틀 등)는 별도로 묶지 않고 첫 슬라이드 앞에 붙인다.
  for (let b = 0; b < slideBoundaries.length; b++) {
    const from = slideBoundaries[b]!;
    const to = b + 1 < slideBoundaries.length ? slideBoundaries[b + 1]! : atoms.length;
    const lines = atoms.slice(from, to).map((a) => a.text).filter((t) => t.length > 0);
    if (lines.length) slides.push(lines);
  }
  // 어떤 슬라이드 컨테이너도 텍스트를 못 가졌지만 atom 은 있는 경우 → 한 흐름으로.
  if (slides.length === 0) {
    const lines = atoms.map((a) => a.text).filter((t) => t.length > 0);
    if (lines.length) slides.push(lines);
  }
  return slides;
}

/** PPT 텍스트의 제어문자 정리: CR(0x0D)=문단끝, VT(0x0B)=줄바꿈을 \n 으로. */
function cleanText(s: string): string {
  return s
    .replace(/\r/g, "\n")
    .replace(/\x0b/g, "\n")
    .replace(/\x00/g, "")
    .trim();
}

export function pptToPreviewHtml(bytes: Uint8Array, opts: PreviewOptions = {}): string {
  // 1급: OfficeArt 절대배치 리치 렌더(도형/이미지/색). 실패하면 텍스트 흐름으로 폴백.
  try {
    return pptToRichHtml(bytes, opts);
  } catch {
    /* 폴백 ↓ */
  }
  const cfb = readCfb(bytes);
  const docBytes = cfb.streams["PowerPoint Document"];
  if (!docBytes) {
    return toPreviewHtml(
      `<div class="ppt-wrap"><p>이 .ppt 에서 "PowerPoint Document" 스트림을 찾지 못했습니다.</p></div>`,
      opts,
    );
  }
  const slides = parseTextBySlide(docBytes);

  const body = slides.length
    ? slides
        .map((lines, i) => {
          const items = lines
            .flatMap((l) => l.split("\n"))
            .map((l) => l.trim())
            .filter((l) => l.length > 0)
            .map((l) => `<p>${esc(l)}</p>`)
            .join("");
          return `<div class="ppt-slide-no">슬라이드 ${i + 1}</div><section class="ppt-slide">${items}</section>`;
        })
        .join("\n")
    : `<div class="ppt-wrap"><p>표시할 텍스트를 찾지 못했습니다(이미지/도형만 있는 슬라이드일 수 있음).</p></div>`;

  const css = `
  body { padding: 24px; background:#eceef0; }
  .ppt-slide-no { font-size:12px; color:#6b7280; margin:18px auto 6px; max-width:720px; }
  .ppt-slide { max-width:720px; margin:0 auto 8px; padding:28px 32px; background:#fff;
    border-radius:8px; box-shadow:0 1px 4px rgba(0,0,0,.12), 0 8px 24px rgba(0,0,0,.08); }
  .ppt-slide p { margin:0 0 8px; font-size:14px; line-height:1.6; color:#1a1a1a; }
  .ppt-slide p:first-child { font-size:20px; font-weight:700; margin-bottom:14px; }
  `;
  return toPreviewHtml(`<div class="ppt-wrap">${body}</div>`, { ...opts, css: (opts.css ?? "") + css });
}

export const pptAdapter: FormatAdapter = {
  id: "ppt",
  label: "PowerPoint 97-2003 프레젠테이션 (.ppt)",
  // 왕복 지원: 텍스트 atom 편집 → 원본 스트림 패치 → CFB 재조립.
  // 길이 보존 편집(전략 A)은 1급, 길이 변경 편집(전략 B)은 베스트에포트(decode 옵트인).
  supportsRoundTrip: true,
  /** CFB 라우팅은 컨테이너로 한다(parts 기반 아님). */
  detect() {
    return false;
  },
  encode(bytes, opts) {
    return encodePptToHtml(bytes, (opts ?? {}) as PreviewOptions);
  },
  decode(html, manifest: Manifest, opts) {
    return decodeHtmlToPpt(html, manifest, opts ?? {});
  },
  toPreviewHtml(bytes, opts) {
    return pptToPreviewHtml(bytes, (opts ?? {}) as PreviewOptions);
  },
};

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
