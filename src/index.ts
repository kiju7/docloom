/**
 * docloom — 양식 보존 docx ↔ 제약 의미적 HTML 무손실 왕복 라이브러리.
 *
 * 공개 API (v0)
 *   encodeToHtml(docx)            → { html, manifest, model }
 *   decodeToDocx(html, manifest)  → docx (Uint8Array)
 *
 * LLM 은 이 라이브러리에 포함되지 않는다. html 을 받아 편집하는 일은
 * 호출하는 쪽의 별도 레이어가 담당한다. docloom 은 "왕복 채널"만 책임진다.
 */
export { encodeToHtml } from "./encode/docxToHtml.js";
export type { EncodeOptions, EncodeResult } from "./encode/docxToHtml.js";

export { decodeToDocx } from "./decode/htmlToDocx.js";
export type { DecodeOptions } from "./decode/htmlToDocx.js";

export { validateHtml } from "./validate/validator.js";
export type { ValidateResult, ValidateReport } from "./validate/validator.js";

export { toPreviewHtml, toPagedHtml, BASE_PREVIEW_CSS, LAYOUT_CSS, FALLBACK_TYPOGRAPHY, PAGE_CSS } from "./preview/preview.js";
export type { PreviewOptions, PagedOptions } from "./preview/preview.js";
export { extractStyleCss } from "./preview/styleCss.js";
export { buildPaletteFromStyles } from "./palette/fromStyles.js";

export { renderPreviewBody } from "./preview/render.js";
export type { SectionProps, PageGeom } from "./preview/render.js";

// docx 미리보기 편의 함수는 docx 어댑터가 소유 — 여기선 재노출(하위호환).
export { docxToPreviewHtml } from "./formats/docx.js";

// ── 평문(CSV) 왕복 + PDF(T2 위치보존) 미리보기 ──────────────────────────────
export { csvToPreviewHtml, csvEncode, csvDecode } from "./formats/csv.js";
export type { CsvDialect } from "./formats/csv.js";

// ── 평문 문서(html/md/txt) 왕복 + 미리보기 ──────────────────────────────────
export { htmlAdapter, htmlEncode, htmlDecode, htmlToPreviewHtml } from "./formats/html.js";
export { mdAdapter, mdEncode, mdDecode, mdToPreviewHtml, mdToHtml, htmlToMd } from "./formats/md.js";
export { txtAdapter, txtEncode, txtDecode, txtToPreviewHtml } from "./formats/txt.js";
export { rtfAdapter, rtfEncode, rtfDecode, rtfToPreviewHtml } from "./formats/rtf.js";
export { pdfToPreviewHtml, pdfModelToPreviewHtml, extractPdfModel, buildPdfFromModel,
         extendPdfModel, pdfModelPagesHtml, pdfModelTotalPages, pdfModelFontFaceCss } from "./formats/pdf.js";
export type { PdfEditModel } from "./formats/pdf.js";
// 플러그형 이미지 디코더 훅 — JPX(JPEG2000)/JBIG2 등을 외부 라이브러리로 처리.
export { registerImageDecoder, unregisterImageDecoder, clearImageDecoders } from "./core/pdf/imageDecoders.js";
export type { ImageDecoder, ImageDecodeInfo, DecodedImage } from "./core/pdf/imageDecoders.js";

// ── rhwp 기반 HWP/HWPX 편집 채널(opt-in) — 표 셀까지 LLM 이 읽고 수정 ────────────
// rhwp WASM 은 호출측이 초기화한 HwpDocument 를 인자로 받는다(코어는 WASM 미의존).
export { hwpToEditableHtml, applyHwpEdits, hwpToRichPreviewHtml, hwpToHybridPreviewHtml, hwpToFaithfulPreviewHtml, hwpToSvgPreviewHtml, hwpToTreePreviewHtml } from "./rhwp/hwpEdit.js";
export type { RhwpDoc } from "./rhwp/hwpEdit.js";

// ── 아래한글 HWPX (OWPML) 왕복 API ──────────────────────────────────────────
export { encodeHwpxToHtml } from "./encode/hwpxToHtml.js";
export type { HwpxEncodeOptions, HwpxEncodeResult } from "./encode/hwpxToHtml.js";
export { decodeHtmlToHwpx } from "./decode/htmlToHwpx.js";
export type { HwpxDecodeOptions } from "./decode/htmlToHwpx.js";
export { hwpxAdapter, hwpxToPreviewHtml } from "./formats/hwpx.js";
export { buildPaletteFromHwpx, parseCharMarks } from "./palette/fromHwpx.js";
export { extractHwpxStyleCss } from "./preview/hwpxStyleCss.js";
export { isHwpx } from "./core/detect.js";

// ── 아래한글 HWP 5.0 (바이너리/CFB) 왕복 API ────────────────────────────────
export { encodeHwpToHtml } from "./encode/hwpToHtml.js";
export type { HwpEncodeOptions, HwpEncodeResult } from "./encode/hwpToHtml.js";
export { decodeHtmlToHwp } from "./decode/hwpToHwp.js";
export type { HwpDecodeOptions } from "./decode/hwpToHwp.js";
export { hwpAdapter, hwpToPreviewHtml } from "./formats/hwp.js";
export { buildPaletteFromHwp, parseCharMarksFromDocInfo } from "./hwp/docinfo.js";
export { readCfb, writeCfb, buildCfbModel, isCfbBytes } from "./core/cfb.js";

// ── 멀티포맷 (제네릭) API ────────────────────────────────────────────────
// 바이트에서 포맷(docx/pptx/xlsx)을 자동판별해 알맞은 어댑터로 위임한다.
//   encode/decode : 왕복(현재 docx 만)   previewHtml : 미리보기(docx/pptx/xlsx)
// (previewHtml 은 바이트→완결 HTML. 본문 조각용 저수준 toPreviewHtml 과 구분.)
export { encode, decode, toPreviewHtml as previewHtml, editablePreviewHtml, adapterFor, getAdapter, ADAPTERS } from "./registry.js";
export type { EditablePreview } from "./registry.js";
export type { FormatAdapter, OfficeFormat } from "./core/format.js";
export { detectContainer, detectOoxml, detectTextSubtype, formatFromFilename } from "./core/detect.js";

export {
  DEFAULT_PALETTE,
  styleKeyFromDocxId,
  docxIdFromStyleKey,
  styleKeyFromClass,
  classFromStyleKey,
} from "./palette/palette.js";
export type { Palette, PaletteEntry } from "./palette/palette.js";

export type { DocModel, Block, Run, Mark } from "./model/docModel.js";
export type { Manifest } from "./model/manifest.js";

// ── compose (양식 채움 + LLM) ───────────────────────────────────────────────
export { composeDocument, jsonFill, extractDescriptor, applyFill, sanitizeInline } from "./compose/index.js";
export type {
  ComposeDeps,
  ComposeResult,
} from "./compose/index.js";
export type { FillStrategy, FillResult, LlmClient, TemplateDescriptor, Slot, RepeatGroup } from "./compose/types.js";
export { createOllamaClient } from "./llm/ollama.js";
export type { OllamaOptions } from "./llm/ollama.js";
