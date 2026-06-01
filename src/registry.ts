/**
 * 포맷 레지스트리 + 제네릭 디스패처.
 *
 * 바이트를 받아 컨테이너 종류(zip/cfb)와 OOXML 콘텐츠타입으로 포맷을 판별하고,
 * 알맞은 FormatAdapter 로 위임한다. 새 포맷 지원 = 어댑터 하나를 ADAPTERS 에 등록.
 */
import type { FormatAdapter, OfficeFormat, PreviewOptionsBase } from "./core/format.js";
import type { Manifest } from "./model/manifest.js";
import { readZip } from "./core/zip.js";
import { toPreviewHtml as wrapPreviewBody } from "./preview/preview.js";
import { detectContainer, detectOoxml, detectCfbSubtype, detectTextSubtype, isHwpx } from "./core/detect.js";
import { docxAdapter } from "./formats/docx.js";
import { pptxAdapter } from "./formats/pptx.js";
import { xlsxAdapter } from "./formats/xlsx.js";
import { csvAdapter } from "./formats/csv.js";
import { htmlAdapter } from "./formats/html.js";
import { mdAdapter } from "./formats/md.js";
import { txtAdapter } from "./formats/txt.js";
import { pdfAdapter } from "./formats/pdf.js";
import { hwpxAdapter } from "./formats/hwpx.js";
import { hwpAdapter } from "./formats/hwp.js";
import { xlsAdapter } from "./formats/xls.js";
import { pptAdapter } from "./formats/ppt.js";
import { docAdapter } from "./formats/doc.js";
import { readCfb } from "./core/cfb.js";

/** 등록된 어댑터(OOXML 3종 + 평문/페이지 2종. 구버전 바이너리는 로드맵). */
export const ADAPTERS: Record<OfficeFormat, FormatAdapter | undefined> = {
  docx: docxAdapter,
  pptx: pptxAdapter,
  xlsx: xlsxAdapter,
  csv: csvAdapter,
  html: htmlAdapter,
  md: mdAdapter,
  txt: txtAdapter,
  pdf: pdfAdapter,
  hwpx: hwpxAdapter,
  hwp: hwpAdapter,
  doc: docAdapter,
  ppt: pptAdapter,
  xls: xlsAdapter,
};

export function getAdapter(format: OfficeFormat): FormatAdapter {
  const a = ADAPTERS[format];
  if (!a) {
    throw new Error(
      `[docloom] '${format}' 포맷 어댑터가 아직 없습니다. 현재 지원: docx·csv(왕복), pptx·xlsx·pdf(미리보기). ` +
        `구버전 바이너리(doc/ppt/xls)는 OLE2/CFB 단계에서 추가 예정.`,
    );
  }
  return a;
}

/** 평문 컨테이너 안에서만 의미 있는 포맷(매직 없이 내용/확장자로 구분). */
const TEXT_FORMATS = new Set<OfficeFormat>(["csv", "html", "md", "txt"]);

/**
 * 바이트에서 포맷을 판별하고 어댑터를 돌려준다.
 * `hint`(보통 파일 확장자에서 유도) 는 평문(csv/html/md/txt)처럼 매직으로 구분되지 않는
 * 포맷을 정확히 라우팅하는 데 쓴다. 컨테이너 종류와 어긋나는 힌트는 무시한다.
 */
export function adapterFor(bytes: Uint8Array, hint?: OfficeFormat): FormatAdapter {
  const container = detectContainer(bytes);
  if (container === "cfb") {
    // CFB 안에 FileHeader 가 있고 시그니처가 맞으면 HWP 5.0 → hwp 어댑터.
    const cfb = readCfb(bytes);
    if (hwpAdapter.detect(cfb.streams)) return getAdapter("hwp");
    // 스트림 이름으로 구버전 Office 바이너리 하위포맷 식별(xls/ppt 미리보기 지원).
    const sub = detectCfbSubtype(cfb.streams);
    if (sub === "xls") return getAdapter("xls");
    if (sub === "ppt") return getAdapter("ppt");
    if (sub === "doc") return getAdapter("doc");
    throw new Error(
      "[docloom] 인식할 수 없는 OLE2/CFB 복합문서입니다. " +
        "최신 형식(docx/pptx/xlsx) 또는 한글(.hwp/.hwpx)로 저장 후 사용하세요.",
    );
  }
  // 비-zip 포맷은 unzip 없이 컨테이너 종류로 바로 라우팅한다.
  if (container === "pdf") return getAdapter("pdf");
  if (container === "text") {
    // 확장자 힌트가 평문 포맷이면 그걸 신뢰, 아니면 내용으로 추정(csv/html/md/txt).
    const sub = hint && TEXT_FORMATS.has(hint) ? hint : detectTextSubtype(bytes);
    return getAdapter(sub);
  }
  if (container !== "zip") {
    throw new Error("[docloom] 인식할 수 없는 파일입니다 (zip/PDF/평문 어디에도 해당하지 않음).");
  }
  const parts = readZip(bytes);
  // HWPX(아래한글)도 zip 컨테이너 — OOXML 보다 먼저 시그니처로 가른다.
  if (isHwpx(parts)) return getAdapter("hwpx");
  const fmt = detectOoxml(parts);
  if (!fmt) throw new Error("[docloom] OOXML 포맷을 판별할 수 없습니다 (word//ppt//xl/ 없음).");
  return getAdapter(fmt);
}

// ── 제네릭 공개 함수 (포맷 자동판별) ────────────────────────────────────────

/** 문서 바이트 → 편집/왕복용 { html, manifest }. 포맷 자동판별(opts.format 힌트 우선). */
export function encode(bytes: Uint8Array, opts?: Record<string, unknown> & { format?: OfficeFormat }) {
  return adapterFor(bytes, opts?.format).encode(bytes, opts);
}

/**
 * 편집된 html + manifest → 문서 바이트. 포맷은 opts.format > manifest.format > docx
 * 순으로 결정한다(encode 가 manifest.format 을 심어두므로 보통 명시 불필요).
 */
export function decode(
  html: string,
  manifest: Manifest,
  opts?: Record<string, unknown> & { format?: OfficeFormat },
): Uint8Array {
  const fmt = opts?.format ?? manifest.format ?? "docx";
  return getAdapter(fmt).decode(html, manifest, opts);
}

/** 문서 바이트 → 미리보기 HTML. 포맷 자동판별(opts.format 힌트 우선). */
export function toPreviewHtml(bytes: Uint8Array, opts?: PreviewOptionsBase): string {
  return adapterFor(bytes, opts?.format).toPreviewHtml(bytes, opts);
}

/** "미리보기에서 바로 편집"용 결과: 스타일+contenteditable 자립 HTML + 복원 키트. */
export interface EditablePreview {
  /** 자립 HTML 페이지. 편집영역은 id="dl-edit"(contenteditable). */
  html: string;
  manifest: Manifest;
  format: OfficeFormat;
}

const EDIT_CSS = `
  #dl-edit { outline: none; }
  #dl-edit [contenteditable="false"] { user-select: none; }
  /* 편집 어포던스: 표/셀 경계 보이게(csv 등). */
  #dl-edit table { border-collapse: collapse; }
  #dl-edit td, #dl-edit th { border: 1px solid #d6d9dd; padding: 4px 8px; min-width: 24px; }
  #dl-edit:focus-within { }
`;

/**
 * 편집채널 HTML(encode 결과)을 **미리보기 스타일로 입히고 contenteditable** 로 감싼 자립 페이지.
 * 사용자가 그 화면에서 글자를 바로 고친 뒤, 편집된 `#dl-edit` 내부 HTML 을 decode 에 넘기면
 * 원본 포맷으로 복원된다(미리보기≈편집채널인 docx·csv 에 자연스럽다).
 */
export function editablePreviewHtml(
  bytes: Uint8Array,
  opts: { title?: string; format?: OfficeFormat } = {},
): EditablePreview {
  const ad = adapterFor(bytes, opts.format);
  if (!ad.supportsRoundTrip) {
    throw new Error(`[docloom] '${ad.id}' 는 편집 왕복을 지원하지 않습니다(미리보기 전용).`);
  }
  const { html, manifest } = ad.encode(bytes);
  const page = wrapPreviewBody(`<div id="dl-edit" contenteditable="true">${html}</div>`, {
    title: opts.title,
    css: EDIT_CSS,
  });
  return { html: page, manifest, format: ad.id };
}
