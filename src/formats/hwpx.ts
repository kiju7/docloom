/**
 * hwpx 포맷 어댑터 — 아래한글 HWPX(OWPML)의 완전 왕복 구현.
 *
 * HWPX 는 docx 와 같은 zip+xml 계열이라 docx 어댑터를 본보기로 동일 인터페이스를 채운다.
 * encode/decode 는 OWPML 전용 파이프라인을 쓰고, 미리보기는 공유 직렬화 + header.xml
 * 타이포그래피 CSS 로 구성한다.
 */
import type { FormatAdapter, PreviewOptionsBase } from "../core/format.js";
import type { Manifest } from "../model/manifest.js";
import type { Palette } from "../palette/palette.js";
import { encodeHwpxToHtml, type HwpxEncodeOptions } from "../encode/hwpxToHtml.js";
import { decodeHtmlToHwpx, type HwpxDecodeOptions } from "../decode/htmlToHwpx.js";
import { buildPaletteFromHwpx } from "../palette/fromHwpx.js";
import { extractHwpxStyleCss } from "../preview/hwpxStyleCss.js";
import { renderHwpxResult } from "../preview/hwpxRender.js";
import { toPagedHtml, type PreviewOptions } from "../preview/preview.js";
import { readZip, tryPartToText } from "../core/zip.js";
import { HEADER_PART, MIMETYPE } from "../hwpx/owpml.js";

export type HwpxPreviewOptions = { palette?: Palette } & PreviewOptions;

/** hwpx 바이트 → 브라우저 미리보기 HTML(글자색·크기·정렬·표 테두리·그림·머릿말/꼬리말·페이지). */
export function hwpxToPreviewHtml(hwpx: Uint8Array, opts: HwpxPreviewOptions = {}): string {
  const parts = readZip(hwpx);
  const headerXml = tryPartToText(parts, HEADER_PART);
  const palette = opts.palette ?? buildPaletteFromHwpx(headerXml);
  const result = renderHwpxResult(parts, palette);
  const typographyCss = (extractHwpxStyleCss(headerXml, palette) || "") + HWP_TABLE_CSS;
  return toPagedHtml(result, { title: opts.title, typographyCss });
}

/** 표 셀 기본 테두리는 borderFill 인라인 스타일이 결정하도록 약하게(없으면 옅은 회색). */
const HWP_TABLE_CSS = `
.hwp-table { border-collapse: collapse; width: auto; max-width: 100%; }
.hwp-table td { padding: 2px 6px; }
`;

export const hwpxAdapter: FormatAdapter = {
  id: "hwpx",
  label: "한글 문서 (.hwpx)",
  supportsRoundTrip: true,
  detect(parts) {
    const mimetype = tryPartToText(parts, "mimetype");
    if (mimetype && mimetype.trim() === MIMETYPE) return true;
    return Object.keys(parts).some((p) => p === "Contents/section0.xml" || p === HEADER_PART);
  },
  encode(bytes, opts) {
    return encodeHwpxToHtml(bytes, (opts ?? {}) as HwpxEncodeOptions);
  },
  decode(html: string, manifest: Manifest, opts) {
    return decodeHtmlToHwpx(html, manifest, (opts ?? {}) as HwpxDecodeOptions);
  },
  toPreviewHtml(bytes, opts) {
    return hwpxToPreviewHtml(bytes, (opts ?? {}) as HwpxPreviewOptions);
  },
};
