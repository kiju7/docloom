/**
 * docx zip 입출력. 실제 구현은 포맷 무관 core/zip 에 있고, 여기서는 docx 친화적
 * 이름(readDocxZip/writeDocxZip)으로 재노출한다(하위호환).
 */
export { partToText, tryPartToText, textToPart } from "../core/zip.js";
import { readZip, writeZip } from "../core/zip.js";

/** docx 바이트 → { 경로: 바이트 } 맵. */
export const readDocxZip = readZip;
/** { 경로: 바이트 } 맵 → docx 바이트. */
export const writeDocxZip = writeZip;
