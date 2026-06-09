/**
 * compose 공개 진입점.
 *
 * 업로드 문서 바이트를 양식으로 쓰고, 자료(프롬프트)를 채워 같은 포맷·양식의 문서 바이트로
 * 되돌린다. 흐름: encode(편집채널+manifest) → 전략.fill(편집된 HTML) → decode(양식 무손실).
 * 전략만 갈아끼우면 JSON 채움/HTML 가드레일을 같은 파이프라인에서 비교할 수 있다.
 */
import type { OfficeFormat } from "../core/format.js";
import { encode, decode, adapterFor } from "../registry.js";
import type { FillStrategy, LlmClient } from "./types.js";
import { jsonFill } from "./strategies/jsonFill.js";
import { composePdf } from "./pdfFill.js";

export interface ComposeDeps {
  llm: LlmClient;
  model: string;
  /** 기본 jsonFill. */
  strategy?: FillStrategy;
  /** 포맷 힌트(보통 파일 확장자에서). 미지정 시 자동판별. */
  format?: OfficeFormat;
}

export interface ComposeResult {
  /** 양식 보존된 결과 문서 바이트(원본과 같은 포맷). */
  bytes: Uint8Array;
  /** 채움 후 편집 HTML(미리보기/디버그용). */
  editedHtml: string;
  /** 전략이 남긴 메타(슬롯 수·채운 수 등). */
  meta?: Record<string, unknown>;
}

/** 문서 바이트 + 자료 → 양식 보존 결과 바이트. */
export async function composeDocument(
  bytes: Uint8Array,
  material: string,
  deps: ComposeDeps,
): Promise<ComposeResult> {
  // PDF 는 HTML 왕복이 아니라 PdfEditModel 경로(좌표 글자조각 채움).
  if (adapterFor(bytes, deps.format).id === "pdf") {
    const { bytes: out, meta } = await composePdf(bytes, material, deps.llm, deps.model);
    return { bytes: out, editedHtml: "", meta };
  }

  const strategy = deps.strategy ?? jsonFill;
  const { html, manifest } = encode(bytes, { format: deps.format }) as {
    html: string;
    manifest: import("../model/manifest.js").Manifest;
  };
  const { editedHtml, meta } = await strategy.fill({
    editableHtml: html,
    manifest,
    material: material,
    llm: deps.llm,
    model: deps.model,
  });
  const out = decode(editedHtml, manifest, { format: deps.format });
  return { bytes: out, editedHtml, meta };
}

export { jsonFill } from "./strategies/jsonFill.js";
export { extractDescriptor } from "./descriptor.js";
export { applyFill, sanitizeInline } from "./fill.js";
export type { FillStrategy, FillResult, LlmClient, TemplateDescriptor, Slot, RepeatGroup } from "./types.js";
