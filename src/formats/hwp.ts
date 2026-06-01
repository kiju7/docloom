/**
 * hwp 포맷 어댑터 — 아래한글 HWP 5.0(바이너리/CFB)의 완전 왕복 구현.
 *
 * HWP 는 zip 이 아니라 CFB 컨테이너라, 레지스트리의 cfb 분기에서 readCfb 후 detect 를
 * 호출한다(여기 detect 는 CFB 스트림 맵을 받는다). encode/decode 는 HWP 레코드 파이프라인을
 * 쓰고, 미리보기는 공유 직렬화로 구성한다.
 */
import type { FormatAdapter, PreviewOptionsBase } from "../core/format.js";
import type { Manifest } from "../model/manifest.js";
import type { Palette } from "../palette/palette.js";
import { encodeHwpToHtml, type HwpEncodeOptions } from "../encode/hwpToHtml.js";
import { decodeHtmlToHwp, type HwpDecodeOptions } from "../decode/hwpToHwp.js";
import { parseFileHeader } from "../hwp/record.js";
import { renderHwpResult } from "../preview/hwpRender.js";
import { toPagedHtml, type PreviewOptions } from "../preview/preview.js";

export type HwpPreviewOptions = { palette?: Palette } & PreviewOptions;

/** hwp 바이트 → 브라우저 미리보기 HTML(글자색·크기·정렬·표 테두리·그림·머릿말/꼬리말·페이지). */
export function hwpToPreviewHtml(hwp: Uint8Array, opts: HwpPreviewOptions = {}): string {
  const { result } = renderHwpResult(hwp);
  const typographyCss = `
.hwp-table { border-collapse: collapse; width: auto; max-width: 100%; }
.hwp-table td { padding: 2px 6px; border: 1px solid #c9ccd1; }
.hwp-table td[style] { border: 0; }
`;
  return toPagedHtml(result, { title: opts.title, typographyCss });
}

export const hwpAdapter: FormatAdapter = {
  id: "hwp",
  label: "한글 문서 (.hwp)",
  supportsRoundTrip: true,
  /** 레지스트리가 readCfb 후 CFB 스트림 맵으로 호출한다. FileHeader 시그니처로 판별. */
  detect(streams) {
    const fh = streams["FileHeader"];
    return !!fh && parseFileHeader(fh).signatureOk;
  },
  encode(bytes, opts) {
    return encodeHwpToHtml(bytes, (opts ?? {}) as HwpEncodeOptions);
  },
  decode(html: string, manifest: Manifest, opts) {
    return decodeHtmlToHwp(html, manifest, (opts ?? {}) as HwpDecodeOptions);
  },
  toPreviewHtml(bytes, opts) {
    return hwpToPreviewHtml(bytes, (opts ?? {}) as HwpPreviewOptions);
  },
};
