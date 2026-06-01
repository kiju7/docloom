/**
 * .doc(Word 97-2003) 인라인 이미지 추출 — OfficeArt BLIP → data URI.
 *
 * 그림은 본문 텍스트의 **0x01 특수문자**(picture run)로 자리잡고, 그 문자의 CHPX 에
 * `sprmCPicLocation(0x6A03)` 가 있어 **Data 스트림** 안 PICF 오프셋을 가리킨다.
 * PICF 헤더(cbHeader) 뒤에는 OfficeArt 레코드(SpContainer→FBSE→BLIP)가 이어지고,
 * BLIP 안에 실제 JPEG/PNG/… 바이트가 들어있다.
 *
 * (JDoc legacy/doc_parser.cpp 의 picf_has_image / extract_blip 로직을 TS 로 포팅.)
 */
import { bytesToBase64 } from "../core/base64.js";

export interface DocPicture {
  /** <img src> 용 data URI(또는 미지원 포맷이면 null). */
  uri: string | null;
  /** 표시 폭/높이(px, PICF dxaGoal·mx 반영). 0 이면 미지정. */
  wPx: number;
  hPx: number;
  /** 진단용 포맷("jpeg"|"png"|"emf"…). */
  format: string;
}

const u16 = (d: DataView, o: number) => d.getUint16(o, true);
const u32 = (d: DataView, o: number) => d.getUint32(o, true);

/** Data 스트림의 PICF(dataOffset)에서 이미지를 추출한다. 이미지가 없으면 null. */
export function pictureFromPicf(data: Uint8Array, dataOffset: number): DocPicture | null {
  if (dataOffset + 0x44 > data.length) return null;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const lcb = u32(dv, dataOffset);
  const cbHeader = u16(dv, dataOffset + 4);
  if (lcb <= cbHeader || cbHeader < 0x44) return null;

  // 표시 크기: dxaGoal/dyaGoal(twips) @ +0x1C/+0x1E, mx/my(0.001) @ +0x20/+0x22.
  const dxaGoal = u16(dv, dataOffset + 0x1c);
  const dyaGoal = u16(dv, dataOffset + 0x1e);
  const mx = u16(dv, dataOffset + 0x20) || 1000;
  const my = u16(dv, dataOffset + 0x22) || 1000;
  const wPx = Math.round((((dxaGoal * mx) / 1000) / 1440) * 96);
  const hPx = Math.round((((dyaGoal * my) / 1000) / 1440) * 96);

  const artStart = dataOffset + cbHeader;
  const artEnd = Math.min(dataOffset + lcb, data.length);
  const blip = findBlip(data, dv, artStart, artEnd);
  if (!blip) return null;
  const uri = blip.format && BROWSER_IMG.has(blip.format)
    ? `data:image/${blip.format};base64,${bytesToBase64(data.subarray(blip.start, blip.end))}`
    : null;
  return { uri, wPx, hPx, format: blip.format };
}

/** <img> 로 바로 표시 가능한 포맷(EMF/WMF/TIFF 는 제외 → 자리표시). */
const BROWSER_IMG = new Set(["jpeg", "png", "bmp", "gif"]);

interface BlipRange {
  start: number;
  end: number;
  format: string;
}

/** OfficeArt 레코드를 [from,to) 에서 순회하며 첫 BLIP 의 실제 바이트범위+포맷을 찾는다. */
function findBlip(data: Uint8Array, dv: DataView, from: number, to: number): BlipRange | null {
  let pos = from;
  let guard = 0;
  while (pos + 8 <= to && guard++ < 4096) {
    const ver = u16(dv, pos);
    const type = u16(dv, pos + 2);
    const len = u32(dv, pos + 4);
    if (type < 0xf000 || type > 0xf200) {
      pos += 1;
      continue;
    }
    // 컨테이너(버전 니블 0xF)는 자식으로 하강(헤더만 건너뜀).
    if ((ver & 0x000f) === 0x000f) {
      pos += 8;
      continue;
    }
    if (type === 0xf007 && len >= 36) {
      // FBSE: 36바이트 헤더 + cbName 뒤에 인라인 BLIP.
      const cbName = data[pos + 8 + 33] ?? 0;
      const blipStart = pos + 8 + 36 + cbName;
      const fbseEnd = Math.min(pos + 8 + len, to);
      const b = extractBlip(data, dv, blipStart, fbseEnd);
      if (b) return b;
    } else if (type >= 0xf01a && type <= 0xf029) {
      const b = extractBlip(data, dv, pos, Math.min(pos + 8 + len, to));
      if (b) return b;
    }
    if (pos + 8 + len > to) break;
    pos += 8 + len;
  }
  return null;
}

/** BLIP 레코드(blipPos)에서 이미지 바이트범위+포맷을 뽑는다. */
function extractBlip(data: Uint8Array, dv: DataView, blipPos: number, blipEnd: number): BlipRange | null {
  if (blipPos + 8 > blipEnd) return null;
  const bvi = u16(dv, blipPos);
  const btype = u16(dv, blipPos + 2);
  const blen = u32(dv, blipPos + 4);
  const binst = bvi >> 4;
  let format = "";
  if (btype === 0xf01d) format = "jpeg";
  else if (btype === 0xf01e) format = "png";
  else if (btype === 0xf01a) format = "emf";
  else if (btype === 0xf01b) format = "wmf";
  else if (btype === 0xf01f) format = "bmp";
  else if (btype === 0xf029) format = "tiff";
  if (!format) return null;

  // BLIP 헤더: 8(레코드) + 16(UID) + 1(태그) = 25. 2-UID 변종은 41.
  let skip = 25;
  if (binst === 0x46b || binst === 0x6e1 || binst === 0x6e3 || binst === 0x6e5) skip = 41;
  const start = blipPos + skip;
  const end = Math.min(blipPos + 8 + blen, blipEnd);
  if (start >= end) return null;
  return { start, end, format };
}
