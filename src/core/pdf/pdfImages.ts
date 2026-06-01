/**
 * PDF 이미지 XObject → 브라우저 표시용 data URI.
 *
 * 미리보기는 브라우저가 JPEG/PNG 를 네이티브 디코드하므로, 우리는 픽셀까지 직접 래스터화하지
 * 않는다(=의존성·코드 최소). 대신:
 *   - DCTDecode(JPEG) → 그대로 data:image/jpeg (브라우저가 디코드).
 *   - FlateDecode/LZW raw → 색공간(Gray/RGB/CMYK/Indexed/ICCBased)으로 RGB(A) 전개 후 PNG 인코드.
 *   - ImageMask(1bit 스텐실) → 채움색으로 칠하고 나머지 투명한 PNG.
 *   - SMask(소프트마스크) → 알파 채널로 합성.
 * (JPXDecode/CCITTFax/JBIG2 는 디코더가 커서 미지원 → null 반환, 호출측이 자리표시.)
 *
 * 보안: 폭 1차원·총 픽셀 상한으로 디컴프레션 폭탄/거대 이미지를 막는다.
 */
import { zlibSync, unzlibSync } from "fflate";
import { PdfDocument, PStream, PName, type PDict, type PdfValue } from "./pdfObjects.js";
import { decodeCcitt } from "./pdfCCITT.js";
import { getImageDecoder, type DecodedImage, type ImageDecodeInfo } from "./imageDecoders.js";

/** 메모리 안전 상한 — 한 변/총 픽셀이 넘으면 렌더하지 않는다. */
const MAX_DIM = 12000;
const MAX_PIXELS = 30_000_000; // 30MP

export interface PdfImage {
  mime: "image/jpeg" | "image/png";
  /** 완전한 data URI. */
  uri: string;
  w: number;
  h: number;
}

function lastFilterName(doc: PdfDocument, dict: PDict): string {
  const f = doc.resolve(dict.Filter ?? null);
  if (f instanceof PName) return f.name;
  if (Array.isArray(f) && f.length) {
    const last = doc.resolve(f[f.length - 1]!);
    if (last instanceof PName) return last.name;
  }
  return "";
}

/** /ColorSpace → 컴포넌트 수 + Indexed 팔레트 정보. */
interface CsInfo {
  comps: number;
  indexed?: { hival: number; lut: Uint8Array; baseComps: number };
}
function colorSpace(doc: PdfDocument, csv: PdfValue): CsInfo {
  const r = doc.resolve(csv);
  let name = "";
  if (r instanceof PName) name = r.name;
  else if (Array.isArray(r) && r.length) {
    const first = doc.resolve(r[0]!);
    if (first instanceof PName) name = first.name;
  }
  switch (name) {
    case "DeviceGray": case "CalGray": case "G": return { comps: 1 };
    case "DeviceRGB": case "CalRGB": case "RGB": case "Lab": return { comps: 3 };
    case "DeviceCMYK": case "CMYK": return { comps: 4 };
    case "ICCBased": {
      if (Array.isArray(r) && r.length >= 2) {
        const icc = doc.resolve(r[1]!);
        const n = icc instanceof PStream ? doc.numOf(doc.get(icc.dict, "N"), 3) : 3;
        return { comps: n };
      }
      return { comps: 3 };
    }
    case "Separation": return { comps: 1 };
    case "DeviceN": {
      if (Array.isArray(r) && r.length >= 2) {
        const names = doc.resolve(r[1]!);
        if (Array.isArray(names)) return { comps: names.length };
      }
      return { comps: 1 };
    }
    case "Indexed": case "I": {
      let baseComps = 3, hival = 0;
      let lut: Uint8Array = new Uint8Array(0);
      if (Array.isArray(r) && r.length >= 4) {
        baseComps = colorSpace(doc, r[1]!).comps;
        hival = doc.numOf(r[2]!, 0);
        const lutObj = doc.resolve(r[3]!);
        if (lutObj instanceof Uint8Array) lut = lutObj;
        else if (lutObj instanceof PStream) lut = doc.decodeStream(lutObj);
      }
      return { comps: 1, indexed: { hival, lut, baseComps } };
    }
    default: return { comps: 3 };
  }
}

/** bpc 비트로 압축된 샘플을 픽셀당 8bit 컴포넌트 배열로 펼친다(bpc 1/2/4/8 지원). */
function unpackSamples(data: Uint8Array, w: number, h: number, comps: number, bpc: number): Uint8Array {
  if (bpc === 8) return data;
  const out = new Uint8Array(w * h * comps);
  const max = (1 << bpc) - 1;
  const rowBits = w * comps * bpc;
  const rowBytes = (rowBits + 7) >> 3;
  let oi = 0;
  for (let y = 0; y < h; y++) {
    let bit = 0;
    const rowOff = y * rowBytes;
    for (let i = 0; i < w * comps; i++) {
      const bytePos = rowOff + (bit >> 3);
      const shift = 8 - bpc - (bit & 7);
      let v = bytePos < data.length ? (data[bytePos]! >> shift) & max : 0;
      out[oi++] = bpc === 8 ? v : Math.round((v * 255) / max);
      bit += bpc;
    }
  }
  return out;
}

/** 컴포넌트(Gray/RGB/CMYK/Indexed) → RGB 픽셀(3채널). */
function toRgb(samples: Uint8Array, w: number, h: number, cs: CsInfo, comps: number): Uint8Array {
  const px = w * h;
  const rgb = new Uint8Array(px * 3);
  if (cs.indexed) {
    const { lut, baseComps, hival } = cs.indexed;
    for (let i = 0; i < px; i++) {
      const idx = Math.min(samples[i] ?? 0, hival);
      const off = idx * baseComps;
      if (baseComps === 1) {
        const g = lut[off] ?? 0;
        rgb[i * 3] = g; rgb[i * 3 + 1] = g; rgb[i * 3 + 2] = g;
      } else if (baseComps === 4) {
        cmykToRgb(lut[off] ?? 0, lut[off + 1] ?? 0, lut[off + 2] ?? 0, lut[off + 3] ?? 0, rgb, i * 3);
      } else {
        rgb[i * 3] = lut[off] ?? 0; rgb[i * 3 + 1] = lut[off + 1] ?? 0; rgb[i * 3 + 2] = lut[off + 2] ?? 0;
      }
    }
    return rgb;
  }
  if (comps === 1) {
    for (let i = 0; i < px; i++) { const g = samples[i] ?? 0; rgb[i * 3] = g; rgb[i * 3 + 1] = g; rgb[i * 3 + 2] = g; }
  } else if (comps === 4) {
    for (let i = 0; i < px; i++)
      cmykToRgb(samples[i * 4] ?? 0, samples[i * 4 + 1] ?? 0, samples[i * 4 + 2] ?? 0, samples[i * 4 + 3] ?? 0, rgb, i * 3);
  } else {
    for (let i = 0; i < px; i++) { rgb[i * 3] = samples[i * 3] ?? 0; rgb[i * 3 + 1] = samples[i * 3 + 1] ?? 0; rgb[i * 3 + 2] = samples[i * 3 + 2] ?? 0; }
  }
  return rgb;
}

/** CMYK(0~255) → RGB. PDF DeviceCMYK 는 0=잉크없음 가정(가산 보색). */
function cmykToRgb(c: number, m: number, y: number, k: number, out: Uint8Array, o: number): void {
  out[o] = Math.round(255 * (1 - c / 255) * (1 - k / 255));
  out[o + 1] = Math.round(255 * (1 - m / 255) * (1 - k / 255));
  out[o + 2] = Math.round(255 * (1 - y / 255) * (1 - k / 255));
}

// ── PNG 인코더(8bit, RGB color type 2 / RGBA type 6) ──
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  const crcInput = out.subarray(4, 8 + data.length);
  dv.setUint32(8 + data.length, crc32(crcInput));
  return out;
}
export function encodePng(rgb: Uint8Array, w: number, h: number, alpha?: Uint8Array): Uint8Array {
  const channels = alpha ? 4 : 3;
  // 스캔라인 = [filter=0][row bytes…]
  const raw = new Uint8Array(h * (1 + w * channels));
  let o = 0;
  for (let y = 0; y < h; y++) {
    raw[o++] = 0;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      raw[o++] = rgb[i * 3]!; raw[o++] = rgb[i * 3 + 1]!; raw[o++] = rgb[i * 3 + 2]!;
      if (alpha) raw[o++] = alpha[i] ?? 255;
    }
  }
  const idat = zlibSync(raw);
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h);
  ihdr[8] = 8; ihdr[9] = alpha ? 6 : 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const parts = [sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

function base64(bytes: Uint8Array): string {
  // 청크 단위로 binary string 만들어 btoa (대용량 대비). btoa 는 Node/브라우저 공통.
  let bin = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CH));
  }
  return btoa(bin);
}

/** SMask(소프트마스크) 스트림 → 알파 배열(대상 w×h 로 최근접 리샘플). */
function loadAlpha(doc: PdfDocument, dict: PDict, w: number, h: number): Uint8Array | undefined {
  const sm = doc.resolve(dict.SMask ?? null);
  if (!(sm instanceof PStream)) return undefined;
  const sw = doc.numOf(doc.get(sm.dict, "Width"), 0);
  const sh = doc.numOf(doc.get(sm.dict, "Height"), 0);
  if (sw <= 0 || sh <= 0 || sw * sh > MAX_PIXELS) return undefined;
  const bpc = doc.numOf(doc.get(sm.dict, "BitsPerComponent"), 8);
  const data = unpackSamples(doc.decodeStream(sm), sw, sh, 1, bpc);
  const alpha = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(sh - 1, Math.floor((y * sh) / h));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(sw - 1, Math.floor((x * sw) / w));
      alpha[y * w + x] = data[sy * sw + sx] ?? 255;
    }
  }
  return alpha;
}

/** 등록된 외부 디코더(JPX/JBIG2 등) 호출 → PdfImage. 미등록/실패는 null(자리표시). */
function runExternalDecoder(
  doc: PdfDocument,
  xobj: PStream,
  w: number,
  h: number,
  fill: [number, number, number] | undefined,
  filter: string,
): PdfImage | null {
  const decoder = getImageDecoder(filter);
  if (!decoder) return null;
  const dict = xobj.dict;
  // 선행 필터(있으면)는 풀고, JPX/JBIG2 raw 바이트만 디코더에 넘긴다.
  let data: Uint8Array;
  try { data = doc.decodeStream(xobj); } catch { return null; }

  // JBIG2 공유 세그먼트(/DecodeParms /JBIG2Globals).
  let globals: Uint8Array | undefined;
  let parms = doc.getDict(doc.get(dict, "DecodeParms"));
  if (!parms) {
    const dp = doc.resolve(dict.DecodeParms ?? null);
    if (Array.isArray(dp)) for (let i = dp.length - 1; i >= 0; i--) { const d = doc.getDict(dp[i] ?? null); if (d) { parms = d; break; } }
  }
  const gl = doc.resolve(doc.get(parms, "JBIG2Globals"));
  if (gl instanceof PStream) globals = doc.decodeStream(gl);

  const csObj = doc.resolve(doc.get(dict, "ColorSpace"));
  const csName = csObj instanceof PName ? csObj.name : Array.isArray(csObj) && csObj[0] instanceof PName ? (csObj[0] as PName).name : undefined;
  const imOk = doc.resolve(dict.ImageMask ?? null);
  const info: ImageDecodeInfo = {
    filter,
    width: w,
    height: h,
    bitsPerComponent: doc.numOf(doc.get(dict, "BitsPerComponent"), 8) || 8,
    colorSpace: csName,
    isMask: imOk === true || (imOk instanceof PName && imOk.name === "true"),
    fill: fill ?? [0, 0, 0],
    globals,
  };

  let res: DecodedImage | null;
  try { res = decoder(data, info); } catch { return null; }
  if (!res) return null;
  return decodedToImage(res);
}

/** 디코더 결과(픽셀/URI) → PdfImage. */
function decodedToImage(res: DecodedImage): PdfImage | null {
  const { width: w, height: h } = res;
  if (w <= 0 || h <= 0 || w > MAX_DIM || h > MAX_DIM || w * h > MAX_PIXELS) return null;
  if (res.uri) {
    const mime = res.uri.startsWith("data:image/jpeg") ? "image/jpeg" : "image/png";
    return { mime, uri: res.uri, w, h };
  }
  if (res.pixels) {
    const ch = res.channels ?? (res.pixels.length >= w * h * 4 ? 4 : 3);
    let rgb: Uint8Array;
    let alpha: Uint8Array | undefined;
    if (ch === 4) {
      rgb = new Uint8Array(w * h * 3);
      alpha = new Uint8Array(w * h);
      for (let i = 0; i < w * h; i++) {
        rgb[i * 3] = res.pixels[i * 4] ?? 0;
        rgb[i * 3 + 1] = res.pixels[i * 4 + 1] ?? 0;
        rgb[i * 3 + 2] = res.pixels[i * 4 + 2] ?? 0;
        alpha[i] = res.pixels[i * 4 + 3] ?? 255;
      }
    } else {
      rgb = res.pixels;
    }
    return { mime: "image/png", uri: `data:image/png;base64,${base64(encodePng(rgb, w, h, alpha))}`, w, h };
  }
  return null;
}

/** CCITTFax 이미지 → PdfImage. ImageMask 면 채움색 스텐실, 아니면 흑백 PNG. */
function buildCcitt(doc: PdfDocument, xobj: PStream, w: number, h: number, fill?: [number, number, number]): PdfImage | null {
  const dict = xobj.dict;
  // DecodeParms(배열이면 CCITT 항목=마지막 dict).
  let parms = doc.getDict(doc.get(dict, "DecodeParms"));
  if (!parms) {
    const dp = doc.resolve(dict.DecodeParms ?? null);
    if (Array.isArray(dp)) for (let i = dp.length - 1; i >= 0; i--) { const d = doc.getDict(dp[i] ?? null); if (d) { parms = d; break; } }
  }
  const k = doc.numOf(doc.get(parms, "K"), 0);
  const columns = doc.numOf(doc.get(parms, "Columns"), 1728) || 1728;
  const rowsHint = doc.numOf(doc.get(parms, "Rows"), 0) || h;
  const blackIs1 = doc.get(parms, "BlackIs1") === true;
  if (columns > MAX_DIM || rowsHint > MAX_DIM || columns * rowsHint > MAX_PIXELS) return null;

  const data = doc.decodeStream(xobj); // 선행 필터 적용 후 CCITT raw
  const bits = decodeCcitt(data, k, columns, rowsHint);
  const stride = (columns + 7) >> 3;
  const rows = Math.floor(bits.length / stride);
  if (rows <= 0) return null;
  const cols = columns;
  const isBlack = (x: number, y: number): boolean => {
    const bit = (bits[y * stride + (x >> 3)]! >> (7 - (x & 7))) & 1;
    // 디코더는 1=흑(ITU). BlackIs1=true 면 출력의 1=흑 그대로, false(기본)면 의미만 반대지만
    // 디코더가 이미 실제 흑백을 내므로 시각적 흑은 bit==1. (실파일 검증으로 폴라리티 확정.)
    return blackIs1 ? bit === 1 : bit === 1;
  };

  // ImageMask: 흑(마크)만 채움색으로 칠하고 나머지 투명. Decode [1 0] 이면 반전.
  const imOk = doc.resolve(dict.ImageMask ?? null);
  const isMask = imOk === true || (imOk instanceof PName && imOk.name === "true");
  const dec = doc.resolve(dict.Decode ?? null);
  const invert = Array.isArray(dec) && doc.numOf(dec[0]!, 0) === 1;

  const rgb = new Uint8Array(cols * rows * 3);
  const alpha = isMask ? new Uint8Array(cols * rows) : undefined;
  const [fr, fg, fb] = fill ?? [0, 0, 0];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      let black = isBlack(x, y);
      if (invert) black = !black;
      const i = y * cols + x;
      if (isMask) {
        if (black) { rgb[i * 3] = fr; rgb[i * 3 + 1] = fg; rgb[i * 3 + 2] = fb; alpha![i] = 255; }
      } else {
        const g = black ? 0 : 255;
        rgb[i * 3] = g; rgb[i * 3 + 1] = g; rgb[i * 3 + 2] = g;
      }
    }
  }
  return { mime: "image/png", uri: `data:image/png;base64,${base64(encodePng(rgb, cols, rows, alpha))}`, w: cols, h: rows };
}

/** 이미지 XObject(PStream) → data URI. 미지원/과대/오류는 null. */
export function buildImage(doc: PdfDocument, xobj: PStream, fill?: [number, number, number]): PdfImage | null {
  const dict = xobj.dict;
  const w = doc.numOf(doc.get(dict, "Width"), 0);
  const h = doc.numOf(doc.get(dict, "Height"), 0);
  if (w <= 0 || h <= 0 || w > MAX_DIM || h > MAX_DIM || w * h > MAX_PIXELS) return null;

  const filter = lastFilterName(doc, dict);

  // 거대 코덱(JPX/JBIG2)·미내장 필터는 등록된 플러그형 디코더로 위임(있으면). 없으면 자리표시.
  if (filter === "JPXDecode" || filter === "JBIG2Decode") {
    const ext = runExternalDecoder(doc, xobj, w, h, fill, filter);
    return ext; // 디코더 없으면 null → 호출측 자리표시
  }

  // CCITTFax(G3/G4 팩스) — 스캔 흑백문서. 디코드 → 1bit(1=흑) → 마스크/그레이로 펼침.
  if (filter === "CCITTFaxDecode" || filter === "CCITTFax") {
    return buildCcitt(doc, xobj, w, h, fill);
  }

  // JPEG 패스스루(앞 필터가 있어도 decodeStream 이 DCT 직전까지 풀어 JPEG 바이트만 남긴다).
  if (filter === "DCTDecode" || filter === "DCT") {
    const jpeg = doc.decodeStream(xobj);
    if (jpeg.length < 2 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return null;
    return { mime: "image/jpeg", uri: `data:image/jpeg;base64,${base64(jpeg)}`, w, h };
  }

  const decoded = doc.decodeStream(xobj);
  if (decoded.length === 0) return null;
  const bpc = doc.numOf(doc.get(dict, "BitsPerComponent"), 8) || 8;

  // ImageMask: 1bit 스텐실 → 채움색 칠하고 나머지 투명
  const imOk = doc.resolve(dict.ImageMask ?? null);
  const isMask = imOk === true || (imOk instanceof PName && imOk.name === "true");
  if (isMask) {
    const bits = unpackSamples(decoded, w, h, 1, 1); // 0 또는 255
    // Decode [1 0] 이면 반전
    const dec = doc.resolve(dict.Decode ?? null);
    const invert = Array.isArray(dec) && doc.numOf(dec[0]!, 0) === 1;
    const [fr, fg, fb] = fill ?? [0, 0, 0];
    const rgb = new Uint8Array(w * h * 3);
    const alpha = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
      // 표본 0 = 칠함(기본). invert 면 반대.
      const paint = invert ? (bits[i]! >= 128) : (bits[i]! < 128);
      if (paint) { rgb[i * 3] = fr; rgb[i * 3 + 1] = fg; rgb[i * 3 + 2] = fb; alpha[i] = 255; }
    }
    return { mime: "image/png", uri: `data:image/png;base64,${base64(encodePng(rgb, w, h, alpha))}`, w, h };
  }

  const cs = colorSpace(doc, doc.get(dict, "ColorSpace"));
  let comps = cs.comps;
  // 데이터 길이로 컴포넌트 보정(색공간 추정이 빗나간 경우)
  if (bpc === 8) {
    const got = Math.floor(decoded.length / (w * h));
    if (!cs.indexed && got >= 1 && got <= 4 && got !== comps) comps = got;
  }
  const samples = unpackSamples(decoded, w, h, comps, bpc);
  const rgb = toRgb(samples, w, h, cs, comps);
  const alpha = loadAlpha(doc, dict, w, h);
  return { mime: "image/png", uri: `data:image/png;base64,${base64(encodePng(rgb, w, h, alpha))}`, w, h };
}

// ── PDF 생성기용: 임베딩 가능한 raster 추출(JPEG 패스스루 / 그 외 RGB) ──

/** 임베딩용 이미지 데이터. jpeg 면 그대로, 아니면 RGB(+alpha). */
export interface RasterData {
  w: number;
  h: number;
  comps?: number; // jpeg 의 컴포넌트 수(1/3/4)
  jpeg?: Uint8Array;
  rgb?: Uint8Array; // w*h*3
  alpha?: Uint8Array; // w*h
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** JPEG SOF 마커에서 컴포넌트 수(1=Gray,3=RGB/YCbCr,4=CMYK). */
function jpegComponents(b: Uint8Array): number {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const m = b[i + 1]!;
    // SOF0~SOF15(C0..CF) 단, C4(DHT)/C8(JPG)/CC(DAC) 제외
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return b[i + 9] ?? 3;
    if (m === 0xd8 || m === 0xd9) { i += 2; continue; }
    const len = (b[i + 2]! << 8) | b[i + 3]!;
    i += 2 + len;
  }
  return 3;
}

/** 내가 만든 PNG(필터0, 8bit, color type 2/6) → {rgb, alpha?}. */
function decodeOwnPng(png: Uint8Array): { w: number; h: number; rgb: Uint8Array; alpha?: Uint8Array } | null {
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  if (dv.getUint32(0) !== 0x89504e47) return null;
  const w = dv.getUint32(16), h = dv.getUint32(20);
  const colorType = png[25];
  const channels = colorType === 6 ? 4 : 3;
  let idat: Uint8Array | null = null;
  let i = 8;
  const chunks: Uint8Array[] = [];
  while (i + 8 <= png.length) {
    const len = dv.getUint32(i);
    const type = String.fromCharCode(png[i + 4]!, png[i + 5]!, png[i + 6]!, png[i + 7]!);
    if (type === "IDAT") chunks.push(png.subarray(i + 8, i + 8 + len));
    i += 12 + len;
    if (type === "IEND") break;
  }
  if (!chunks.length) return null;
  const joined = chunks.length === 1 ? chunks[0]! : (() => { const t = chunks.reduce((n, c) => n + c.length, 0); const o = new Uint8Array(t); let k = 0; for (const c of chunks) { o.set(c, k); k += c.length; } return o; })();
  let raw: Uint8Array;
  try { raw = unzlibSync(joined); } catch { return null; }
  const stride = w * channels;
  const rgb = new Uint8Array(w * h * 3);
  const alpha = channels === 4 ? new Uint8Array(w * h) : undefined;
  // 행마다 [filter byte] + stride. PNG up/sub 등 필터 역적용(내 인코더는 0이지만 안전하게 처리).
  const cur = new Uint8Array(stride);
  const prev = new Uint8Array(stride);
  let pos = 0;
  for (let y = 0; y < h; y++) {
    const ft = raw[pos++] ?? 0;
    for (let x = 0; x < stride; x++) {
      const v = raw[pos++] ?? 0;
      const a = x >= channels ? cur[x - channels]! : 0;
      const b = prev[x]!;
      const c = x >= channels ? prev[x - channels]! : 0;
      let r = v;
      if (ft === 1) r = (v + a) & 0xff;
      else if (ft === 2) r = (v + b) & 0xff;
      else if (ft === 3) r = (v + ((a + b) >> 1)) & 0xff;
      else if (ft === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); r = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff; }
      cur[x] = r;
    }
    for (let x = 0; x < w; x++) {
      const i3 = (y * w + x) * 3, ic = x * channels;
      rgb[i3] = cur[ic]!; rgb[i3 + 1] = cur[ic + 1]!; rgb[i3 + 2] = cur[ic + 2]!;
      if (alpha) alpha[y * w + x] = cur[ic + 3]!;
    }
    prev.set(cur);
  }
  return { w, h, rgb, alpha };
}

/** 이미지 XObject → 임베딩용 raster. buildImage 의 모든 디코드(JPEG/Flate/CCITT/색공간/훅)를 재사용. */
export function extractRaster(doc: PdfDocument, xobj: PStream, fill?: [number, number, number]): RasterData | null {
  const img = buildImage(doc, xobj, fill);
  if (!img) return null;
  const comma = img.uri.indexOf(",");
  const bytes = b64ToBytes(img.uri.slice(comma + 1));
  if (img.mime === "image/jpeg") return { w: img.w, h: img.h, comps: jpegComponents(bytes), jpeg: bytes };
  const dec = decodeOwnPng(bytes);
  if (!dec) return null;
  return { w: dec.w, h: dec.h, rgb: dec.rgb, alpha: dec.alpha };
}
