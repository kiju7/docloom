/**
 * 최소 TIFF → PNG data URI 디코더 (브라우저가 TIFF 를 못 그리므로 미리보기용으로 변환).
 *
 * 지원: 단일/다중 strip, 압축 None(1)·LZW(5)·Deflate(8/32946)·PackBits(32773),
 *       Predictor 1/2(수평차분), Photometric Gray(0/1)·RGB(2)·Palette(3), bpc=8,
 *       SamplesPerPixel 1/3/4(+알파). Chunky(PlanarConfig=1)만.
 * 미지원(→null): bpc≠8, CCITT/JPEG-in-TIFF, planar=2, 타일, 16bit 등 → 호출측 자리표시.
 *
 * 압축해제·예측기·PNG 인코딩은 PDF 모듈 프리미티브 재사용.
 */
import { lzwDecode, flateDecode, applyPredictor } from "./pdf/pdfFilters.js";
import { encodePng } from "./pdf/pdfImages.js";
import { bytesToBase64 } from "./base64.js";

interface Reader { u8: Uint8Array; dv: DataView; le: boolean }
const u16 = (r: Reader, o: number) => r.dv.getUint16(o, r.le);
const u32 = (r: Reader, o: number) => r.dv.getUint32(o, r.le);

/** TIFF 태그 값(배열) 읽기. type 3=SHORT,4=LONG,1=BYTE. */
function tagValues(r: Reader, entryOff: number): number[] {
  const type = u16(r, entryOff + 2);
  const count = u32(r, entryOff + 4);
  const size = type === 3 ? 2 : type === 4 ? 4 : 1;
  const total = size * count;
  const dataOff = total <= 4 ? entryOff + 8 : u32(r, entryOff + 8);
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const o = dataOff + i * size;
    out.push(size === 2 ? u16(r, o) : size === 4 ? u32(r, o) : r.u8[o]!);
  }
  return out;
}

/** PackBits(32773) 디코드. */
function unpackBits(src: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < src.length) {
    const n = src[i++]!;
    if (n < 128) { for (let j = 0; j <= n; j++) out.push(src[i++]!); }
    else if (n > 128) { const b = src[i++]!; for (let j = 0; j < 257 - n; j++) out.push(b); }
    // n===128: no-op
  }
  return Uint8Array.from(out);
}

export function tiffToPngDataUri(bytes: Uint8Array): string | null {
  try {
    if (bytes.length < 8) return null;
    const le = bytes[0] === 0x49 && bytes[1] === 0x49; // "II"
    const beMM = bytes[0] === 0x4d && bytes[1] === 0x4d; // "MM"
    if (!le && !beMM) return null;
    const r: Reader = { u8: bytes, dv: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), le };
    if (u16(r, 2) !== 42) return null;
    const ifd = u32(r, 4);
    const n = u16(r, ifd);

    const tags: Record<number, number[]> = {};
    for (let i = 0; i < n; i++) {
      const eo = ifd + 2 + i * 12;
      tags[u16(r, eo)] = tagValues(r, eo);
    }
    const t1 = (id: number, def: number) => (tags[id]?.[0] ?? def);

    const width = t1(256, 0), height = t1(257, 0);
    if (!width || !height || width * height > 30_000_000) return null; // 디컴프레션 폭탄 방어
    const bps = tags[258] ?? [8];
    if (bps.some((b) => b !== 8)) return null; // 8bit 만
    const compression = t1(259, 1);
    const photometric = t1(262, 1);
    const spp = t1(277, bps.length || 1);
    const planar = t1(284, 1);
    if (planar !== 1) return null;
    const predictor = t1(317, 1);
    const rowsPerStrip = t1(278, height);
    const offsets = tags[273] ?? tags[324] ?? [];
    const counts = tags[279] ?? tags[325] ?? [];
    if (!offsets.length || offsets.length !== counts.length) return null;
    const colorMap = tags[320];

    // strip 별 압축해제 → 전체 픽셀바이트.
    const rowBytes = width * spp;
    const full = new Uint8Array(rowBytes * height);
    let wo = 0;
    for (let s = 0; s < offsets.length; s++) {
      const raw = bytes.subarray(offsets[s]!, offsets[s]! + counts[s]!);
      let dec: Uint8Array;
      if (compression === 1) dec = raw;
      else if (compression === 5) dec = lzwDecode(raw, 0); // TIFF LZW = late code-width change
      else if (compression === 8 || compression === 32946) dec = flateDecode(raw);
      else if (compression === 32773) dec = unpackBits(raw);
      else return null;
      const stripRows = Math.min(rowsPerStrip, height - s * rowsPerStrip);
      const need = rowBytes * stripRows;
      if (predictor === 2) dec = applyPredictor(dec.subarray(0, need), 2, spp, 8, width);
      full.set(dec.subarray(0, Math.min(need, dec.length)), wo);
      wo += need;
    }

    // → RGB + 알파.
    const px = width * height;
    const rgb = new Uint8Array(px * 3);
    let alpha: Uint8Array | undefined;
    const hasAlpha = (photometric === 2 && spp >= 4) || (photometric <= 1 && spp >= 2) || (photometric === 3 && spp >= 2);
    if (hasAlpha) alpha = new Uint8Array(px);

    if (photometric === 2) { // RGB
      for (let i = 0; i < px; i++) {
        const si = i * spp;
        rgb[i * 3] = full[si]!; rgb[i * 3 + 1] = full[si + 1]!; rgb[i * 3 + 2] = full[si + 2]!;
        if (alpha) alpha[i] = full[si + 3]!;
      }
    } else if (photometric === 0 || photometric === 1) { // Gray (0=WhiteIsZero 반전)
      const inv = photometric === 0;
      for (let i = 0; i < px; i++) {
        const si = i * spp;
        const g = inv ? 255 - full[si]! : full[si]!;
        rgb[i * 3] = g; rgb[i * 3 + 1] = g; rgb[i * 3 + 2] = g;
        if (alpha) alpha[i] = full[si + 1]!;
      }
    } else if (photometric === 3 && colorMap) { // Palette (ColorMap: R[],G[],B[] 각 16bit, /256)
      const entries = colorMap.length / 3;
      for (let i = 0; i < px; i++) {
        const idx = full[i * spp]!;
        rgb[i * 3] = colorMap[idx]! >> 8;
        rgb[i * 3 + 1] = colorMap[entries + idx]! >> 8;
        rgb[i * 3 + 2] = colorMap[2 * entries + idx]! >> 8;
      }
    } else return null;

    return `data:image/png;base64,${bytesToBase64(encodePng(rgb, width, height, alpha))}`;
  } catch {
    return null;
  }
}
