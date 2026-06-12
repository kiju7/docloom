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
import { structuredFill } from "./strategies/structuredFill.js";
import { composePdf } from "./pdfFill.js";
import { composeHwpRhwp, type HwpDocCtor } from "./hwpRhwp.js";

export interface ComposeDeps {
  llm: LlmClient;
  model: string;
  /** 기본 jsonFill. */
  strategy?: FillStrategy;
  /** 포맷 힌트(보통 파일 확장자에서). 미지정 시 자동판별. */
  format?: OfficeFormat;
  /**
   * rhwp(WASM) HwpDocument 생성자(호출측 주입). 주어지고 입력이 .hwp 면 rhwp 경로로 표 셀까지 채운다.
   * (없으면 순수 TS 경로 — 표는 frozen 이라 셀은 못 채움). 결과는 HWPX 로 나온다.
   */
  HwpDocument?: HwpDocCtor;
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

  // .hwp + rhwp 주입 시: 표 셀까지 채우는 rhwp 경로(결과는 HWPX). 미주입이면 아래 순수 TS 경로로.
  if (deps.HwpDocument && adapterFor(bytes, deps.format).id === "hwp") {
    const { bytes: out, meta } = await composeHwpRhwp(bytes, material, {
      llm: deps.llm,
      model: deps.model,
      HwpDocument: deps.HwpDocument,
    });
    return { bytes: out, editedHtml: "", meta };
  }

  // 기본 전략: structuredFill(빈 칸에 항목/열헤더 라벨을 붙여 정확도↑·토큰↓). jsonFill 은 비교용 opt-in.
  const strategy = deps.strategy ?? structuredFill;
  // editableTables: 문서 표를 frozen(편집불가) 대신 셀 채움 가능한 형태로 인코딩한다.
  // 표를 지원하지 않는 포맷(xlsx 등)은 이 옵션을 무시한다.
  const { html, manifest } = encode(bytes, { format: deps.format, editableTables: true }) as {
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
export { structuredFill } from "./strategies/structuredFill.js";
export { extractDescriptor } from "./descriptor.js";
export { applyFill, sanitizeInline } from "./fill.js";
export type { FillStrategy, FillResult, LlmClient, TemplateDescriptor, Slot, RepeatGroup } from "./types.js";
