/**
 * Office 문서 = zip(OPC) 컨테이너. docx/pptx/xlsx 모두 동일한 zip 컨테이너이므로
 * 이 입출력 원시 연산은 포맷 무관이다.
 * (압축 코덱은 fflate — 바이트 코덱일 뿐, 변환 로직은 docloom 이 직접 구현한다.)
 */
import { unzipSync, zipSync } from "fflate";

/** Office 문서 바이트 → { 경로: 바이트 } 맵. */
export function readZip(bytes: Uint8Array): Record<string, Uint8Array> {
  return unzipSync(bytes);
}

/** { 경로: 바이트 } 맵 → Office 문서 바이트. */
export function writeZip(parts: Record<string, Uint8Array>): Uint8Array {
  return zipSync(parts);
}

const td = new TextDecoder();
const te = new TextEncoder();

export function partToText(parts: Record<string, Uint8Array>, path: string): string {
  const buf = parts[path];
  if (!buf) throw new Error(`문서 안에 '${path}' part 가 없음`);
  return td.decode(buf);
}

/** part 가 있으면 텍스트로, 없으면 undefined (필수 아님). */
export function tryPartToText(parts: Record<string, Uint8Array>, path: string): string | undefined {
  const buf = parts[path];
  return buf ? td.decode(buf) : undefined;
}

export function textToPart(text: string): Uint8Array {
  return te.encode(text);
}
