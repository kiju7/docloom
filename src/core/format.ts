/**
 * 멀티포맷 어댑터 계약.
 *
 * docloom 의 최종 목표는 doc/docx/ppt/pptx/xls/xlsx 전부 지원이다. 각 포맷은
 * 동일한 철학(원본 part 는 보존, 콘텐츠만 재생성)을 따르되 세부 매핑이 다르므로,
 * 공통 인터페이스 FormatAdapter 뒤에 포맷별 구현을 끼운다. registry 가 디스패치한다.
 *
 *   encode      : 문서 바이트 → { html(편집/왕복용), manifest(복원 키트) }
 *   decode      : 편집된 html + manifest → 문서 바이트 (양식 보존)
 *   toPreviewHtml : 문서 바이트 → 브라우저 미리보기용 완결 HTML
 */
import type { Manifest } from "../model/manifest.js";

export type OfficeFormat =
  | "docx"
  | "pptx"
  | "xlsx"
  | "doc"
  | "ppt"
  | "xls"
  // 아래한글(한국 표준 워드프로세서)
  | "hwpx" // OWPML/KS X 6101 — zip+xml (docx 와 같은 컨테이너 계열)
  | "hwp" // HWP 5.0 — OLE2/CFB 바이너리
  // 비-Office 평문/페이지 포맷 (zip 컨테이너가 아님)
  | "csv" // 평문 표(RFC4180) — 왕복 1급
  | "html" // 웹 문서(HTML) — 본문 왕복 1급(셸은 원본 보존)
  | "md" // 마크다운(GFM 부분집합) — HTML 렌더 편집 채널로 왕복
  | "txt" // 순수 텍스트 — 줄/방언 보존 왕복 1급
  | "rtf" // 서식 텍스트(RTF) — 구조 보존 + 텍스트 런 패치 왕복
  | "pdf"; // 고정 레이아웃 페이지(PDF) — 위치보존 미리보기 전용

/** 모든 포맷이 공유하는 결과 타입. */
export interface EncodeResultBase {
  html: string;
  manifest: Manifest;
}

export interface PreviewOptionsBase {
  title?: string;
  /** "paged"(워드처럼 시트 분할) | "flow"(연속). 포맷별로 의미가 다를 수 있음. */
  layout?: "paged" | "flow";
  /**
   * 포맷 힌트(보통 파일 확장자에서 유도). 평문 컨테이너(text)는 csv/html/md/txt 가
   * 매직으로 구분되지 않으므로, 호출측이 확장자를 알면 이 힌트로 정확히 라우팅한다.
   * (없으면 내용 추정으로 판별.)
   */
  format?: OfficeFormat;
}

export interface FormatAdapter {
  id: OfficeFormat;
  /** 사람이 읽는 이름. */
  label: string;
  /** 왕복 편집 채널을 지원하는가(encode/decode). false 면 미리보기 전용. */
  supportsRoundTrip: boolean;

  /** zip 해제된 part 맵으로 이 포맷인지 판별. */
  detect(parts: Record<string, Uint8Array>): boolean;

  /** 문서 바이트 → 편집/왕복용 html + 복원 manifest. */
  encode(bytes: Uint8Array, opts?: Record<string, unknown>): EncodeResultBase;

  /** 편집된 html + manifest → 문서 바이트. */
  decode(html: string, manifest: Manifest, opts?: Record<string, unknown>): Uint8Array;

  /** 문서 바이트 → 미리보기 HTML. */
  toPreviewHtml(bytes: Uint8Array, opts?: PreviewOptionsBase): string;
}

/** 아직 왕복을 구현하지 않은 포맷이 명확한 에러를 던질 때 쓰는 헬퍼. */
export function notImplemented(id: OfficeFormat, op: "encode" | "decode"): never {
  throw new Error(
    `[docloom] ${id} 포맷의 ${op}(왕복)는 아직 미구현입니다. ` +
      `현재 ${id} 는 toPreviewHtml(미리보기)만 지원합니다. 로드맵: formats/${id} 참고.`,
  );
}
