/**
 * 포맷 자동 판별.
 *
 * OOXML(docx/pptx/xlsx)은 zip 컨테이너라 [Content_Types].xml 의 main 파트 콘텐츠타입,
 * 또는 특징 디렉터리(word//ppt//xl/)로 구분한다. 구버전 바이너리(doc/ppt/xls)는
 * zip 이 아니라 OLE2/CFB 복합문서라 매직 바이트(D0 CF 11 E0)로 식별한다(현재는 표시만).
 */
import { tryPartToText } from "./zip.js";
import type { OfficeFormat } from "./format.js";

/** OLE2/CFB(구버전 doc/ppt/xls 공통) 매직 바이트. */
const CFB_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
/** zip(PK) 매직 바이트. */
const ZIP_MAGIC = [0x50, 0x4b];
/** PDF 매직 바이트 ("%PDF"). 보통 파일 맨 앞이지만 BOM/공백이 앞설 수 있어 선두 일부를 스캔한다. */
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46];

export function isZip(bytes: Uint8Array): boolean {
  return ZIP_MAGIC.every((b, i) => bytes[i] === b);
}

export function isCfb(bytes: Uint8Array): boolean {
  return CFB_MAGIC.every((b, i) => bytes[i] === b);
}

/** "%PDF" 가 선두 1KB 안에 나타나면 PDF 로 본다(드물게 앞에 잡쓰레기가 붙는 파일 대비). */
export function isPdf(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length - PDF_MAGIC.length, 1024);
  for (let i = 0; i <= limit; i++) {
    if (PDF_MAGIC.every((b, j) => bytes[i + j] === b)) return true;
  }
  return false;
}

/**
 * 평문(텍스트)인지 가볍게 추정. NUL 바이트가 있으면 바이너리로 본다.
 * (CSV 는 매직이 없어 "바이너리 컨테이너가 아닌 것"으로 소거 판별한다.)
 */
export function looksLikeText(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 4096);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return false;
  return n > 0;
}

/** HWPX(아래한글 OWPML) 시그니처. zip 안의 mimetype 파일이 이 값이면 HWPX. */
const HWPX_MIMETYPE = "application/hwp+zip";

/**
 * zip 해제된 part 맵이 HWPX(OWPML)인지 판별.
 * mimetype 파일(application/hwp+zip) 또는 특징 파트(Contents/section0.xml·header.xml)로 식별.
 */
export function isHwpx(parts: Record<string, Uint8Array>): boolean {
  const mimetype = tryPartToText(parts, "mimetype");
  if (mimetype && mimetype.trim() === HWPX_MIMETYPE) return true;
  return Object.keys(parts).some((p) => p === "Contents/section0.xml" || p === "Contents/header.xml");
}

/**
 * zip 해제된 part 맵에서 OOXML 포맷을 판별. 알 수 없으면 undefined.
 * (구버전 바이너리는 zip 이 아니므로 여기 오지 않는다 — detectFromBytes 참고.)
 */
export function detectOoxml(parts: Record<string, Uint8Array>): OfficeFormat | undefined {
  const ct = tryPartToText(parts, "[Content_Types].xml") ?? "";
  if (ct.includes("wordprocessingml.document.main")) return "docx";
  if (ct.includes("presentationml.presentation.main")) return "pptx";
  if (ct.includes("spreadsheetml.sheet.main")) return "xlsx";
  // content-types 가 모호하면 디렉터리 구조로 보강
  const paths = Object.keys(parts);
  if (paths.some((p) => p.startsWith("word/"))) return "docx";
  if (paths.some((p) => p.startsWith("ppt/"))) return "pptx";
  if (paths.some((p) => p.startsWith("xl/"))) return "xlsx";
  return undefined;
}

/**
 * 원본 바이트에서 컨테이너 종류 추정. 판별 우선순위는 매직이 명확한 것부터:
 *   zip(docx/pptx/xlsx) → cfb(구버전 doc/ppt/xls) → pdf → text(csv) → unknown.
 * pdf 는 자체 객체 구조, text 는 매직이 없어 "바이너리가 아님"으로 소거 판별한다.
 */
export function detectContainer(bytes: Uint8Array): "zip" | "cfb" | "pdf" | "text" | "unknown" {
  if (isZip(bytes)) return "zip";
  if (isCfb(bytes)) return "cfb";
  if (isPdf(bytes)) return "pdf";
  if (looksLikeText(bytes)) return "text";
  return "unknown";
}

// ignoreBOM: 선행 BOM 을 벗기지 않아야 정확히 본다(여기선 직접 슬라이스로 제거).
const TEXT_DECODER = new TextDecoder("utf-8", { ignoreBOM: true, fatal: false });

/** 평문 컨테이너 안에서만 의미 있는 텍스트 포맷들(매직 없이 내용/확장자로 구분). */
export type TextFormat = "csv" | "html" | "md" | "txt";

/** 마크다운 특징 마커(헤딩·코드펜스·리스트·인용·링크·강조·표 구분선)가 있는가. */
function looksLikeMarkdown(text: string): boolean {
  return (
    /^#{1,6}\s+\S/m.test(text) || // ATX 헤딩
    /^```|^~~~/m.test(text) || // 코드펜스
    /^\s*([-*+])\s+\S/m.test(text) || // 불릿 리스트
    /^\s*\d+\.\s+\S/m.test(text) || // 번호 리스트
    /^>\s+\S/m.test(text) || // 블록인용
    /\[[^\]]+\]\([^)\s]+\)/.test(text) || // 링크/이미지
    /(\*\*|__)[^\s][^*_]*\1/.test(text) || // 볼드
    /^\s*\|?\s*:?-{3,}:?\s*\|/m.test(text) // GFM 표 구분선
  );
}

/**
 * CSV 처럼 보이는가 — 후보 구분자 중 하나가 (따옴표 밖에서) 여러 줄에 걸쳐
 * **같은 개수**로 나타나면 표로 본다. 같은 개수 요구는 쉼표가 섞인 산문을 배제한다.
 */
function looksLikeCsv(text: string): boolean {
  const lines = text.split(/\r\n|\r|\n/).filter((l) => l.trim().length).slice(0, 20);
  if (lines.length === 0) return false;
  for (const d of [",", ";", "\t", "|"]) {
    const counts = lines.map((l) => countOutsideQuotes(l, d));
    const c0 = counts[0]!;
    if (c0 >= 1 && counts.every((c) => c === c0)) return true;
  }
  return false;
}

/** 한 줄에서 따옴표 밖에 있는 구분자 개수. */
function countOutsideQuotes(line: string, delim: string): number {
  let n = 0;
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') inQ = !inQ;
    else if (!inQ && ch === delim) n++;
  }
  return n;
}

/**
 * 평문 바이트의 하위 포맷을 내용으로 추정: html → md → csv → txt 순.
 * (확장자 힌트가 있으면 호출측이 그걸 우선하고, 이 함수는 폴백으로 쓴다.)
 */
export function detectTextSubtype(bytes: Uint8Array): TextFormat {
  // 앞 64KB 만 봐도 충분(대용량 평문 방어).
  const text = TEXT_DECODER.decode(bytes.subarray(0, 65536)).replace(/^﻿/, "");
  const trimmed = text.replace(/^\s+/, "");
  const lower = trimmed.slice(0, 64).toLowerCase();
  if (lower.startsWith("<!doctype html") || lower.startsWith("<html") || lower.startsWith("<?xml")) return "html";
  if (/^<(html|head|body|div|p|table|section|article|main|nav|header|footer|ul|ol|h[1-6]|meta|title|link|style|script)[\s>/]/i.test(trimmed))
    return "html";
  if (looksLikeMarkdown(text)) return "md";
  if (looksLikeCsv(text)) return "csv";
  return "txt";
}

/** 확장자 → 포맷. 평문/Office 확장자를 모두 다룬다. 모르면 undefined. */
export function formatFromFilename(name: string): OfficeFormat | undefined {
  const m = /\.([a-z0-9]+)\s*$/i.exec(name);
  if (!m) return undefined;
  switch (m[1]!.toLowerCase()) {
    case "docx":
      return "docx";
    case "pptx":
      return "pptx";
    case "xlsx":
      return "xlsx";
    case "doc":
      return "doc";
    case "ppt":
      return "ppt";
    case "xls":
      return "xls";
    case "hwpx":
      return "hwpx";
    case "hwp":
      return "hwp";
    case "pdf":
      return "pdf";
    case "csv":
      return "csv";
    case "htm":
    case "html":
    case "xhtml":
      return "html";
    case "md":
    case "markdown":
    case "mdown":
    case "mkd":
      return "md";
    case "txt":
    case "text":
    case "log":
      return "txt";
    default:
      return undefined;
  }
}

/**
 * CFB(OLE2) 컨테이너의 하위 포맷을 스트림 이름으로 식별.
 *   "Workbook"/"Book" → xls, "PowerPoint Document" → ppt, "WordDocument" → doc.
 * (hwp 는 FileHeader 시그니처로 별도 판별하므로 registry 에서 먼저 거른다.)
 * 알 수 없으면 undefined.
 */
export function detectCfbSubtype(streams: Record<string, Uint8Array>): OfficeFormat | undefined {
  if (streams["Workbook"] || streams["Book"]) return "xls";
  if (streams["PowerPoint Document"]) return "ppt";
  if (streams["WordDocument"]) return "doc";
  return undefined;
}
