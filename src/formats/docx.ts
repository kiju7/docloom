/**
 * docx 포맷 어댑터 — docloom 의 1급(완전 왕복) 포맷.
 *
 * 기존 encode/decode/preview 구현을 FormatAdapter 계약으로 묶는다.
 * 다른 포맷(pptx/xlsx/…)은 이 어댑터를 본보기로 같은 인터페이스를 채운다.
 */
import type { FormatAdapter, PreviewOptionsBase } from "../core/format.js";
import type { Manifest } from "../model/manifest.js";
import { encodeToHtml, type EncodeOptions } from "../encode/docxToHtml.js";
import { decodeToDocx, type DecodeOptions } from "../decode/htmlToDocx.js";
import { readDocxZip } from "../docx/zip.js";
import { renderPreviewBody } from "../preview/render.js";
import { toPreviewHtml, toPagedHtml, type PreviewOptions } from "../preview/preview.js";
import { extractStyleCss } from "../preview/styleCss.js";
import { buildPaletteFromStyles } from "../palette/fromStyles.js";
import { DEFAULT_PALETTE, type Palette } from "../palette/palette.js";

export type DocxPreviewOptions = { palette?: Palette; layout?: "paged" | "flow" } & PreviewOptions;

/**
 * docx 바이트 → 브라우저에서 바로 열 수 있는 미리보기 HTML.
 * 문서 자신의 styles.xml 로 동적 팔레트를 만들고 theme1.xml 폰트까지 해석해
 * 실제 글꼴·크기·색·정렬·용지·다단을 CSS 로 입힌다.
 */
export function docxToPreviewHtml(docx: Uint8Array, opts: DocxPreviewOptions = {}): string {
  const parts = readDocxZip(docx);
  const dec = new TextDecoder();
  const stylesBuf = parts["word/styles.xml"];
  const stylesXml = stylesBuf ? dec.decode(stylesBuf) : undefined;
  const themeBuf = parts["word/theme/theme1.xml"];
  const themeXml = themeBuf ? dec.decode(themeBuf) : undefined;

  const palette = opts.palette ?? (stylesXml ? buildPaletteFromStyles(stylesXml, "doc") : DEFAULT_PALETTE);
  const typographyCss = extractStyleCss(stylesXml, palette, { themeXml }) || undefined;

  const r = renderPreviewBody(parts, palette);

  if (opts.layout === "flow") {
    const flowBody = [
      r.header ? `<div class="docloom-header">${r.header}</div>` : "",
      `<div class="docloom-doc" data-palette="${palette.id}">${r.body}</div>`,
      r.footer ? `<div class="docloom-footer">${r.footer}</div>` : "",
    ]
      .filter(Boolean)
      .join("\n");
    return toPreviewHtml(flowBody, { ...opts, typographyCss: opts.typographyCss ?? typographyCss });
  }

  return toPagedHtml(r, { title: opts.title, typographyCss: opts.typographyCss ?? typographyCss });
}

export const docxAdapter: FormatAdapter = {
  id: "docx",
  label: "Word 문서 (.docx)",
  supportsRoundTrip: true,
  detect(parts) {
    return Object.keys(parts).some((p) => p === "word/document.xml" || p.startsWith("word/"));
  },
  encode(bytes, opts) {
    return encodeToHtml(bytes, (opts ?? {}) as EncodeOptions);
  },
  decode(html: string, manifest: Manifest, opts) {
    return decodeToDocx(html, manifest, (opts ?? {}) as DecodeOptions);
  },
  toPreviewHtml(bytes, opts) {
    return docxToPreviewHtml(bytes, (opts ?? {}) as DocxPreviewOptions);
  },
};
