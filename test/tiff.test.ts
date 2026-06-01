/**
 * TIFF → PNG 디코더 — IFD 파싱·픽셀변환·PNG 인코드 경로 검증(무압축 합성 TIFF).
 * (LZW/Deflate 압축 경로는 실파일로 수동검증; 여기선 코덱 골격을 고정.)
 */
import { describe, it, expect } from "vitest";
import { tiffToPngDataUri } from "../src/core/tiff.js";

/** little-endian 무압축 RGB TIFF 한 장 합성. */
function makeTiff(w: number, h: number, rgb: number[]): Uint8Array {
  const pixels = new Uint8Array(rgb);
  const entries: [number, number, number, number][] = [
    [256, 4, 1, w],        // ImageWidth (LONG)
    [257, 4, 1, h],        // ImageLength
    [258, 3, 1, 8],        // BitsPerSample (단일=8; spp=3 이지만 인라인 단순화)
    [259, 3, 1, 1],        // Compression=none
    [262, 3, 1, 2],        // Photometric=RGB
    [273, 4, 1, 8],        // StripOffsets → 헤더(8) 뒤 픽셀 (아래 배치)
    [277, 3, 1, 3],        // SamplesPerPixel=3
    [278, 4, 1, h],        // RowsPerStrip
    [279, 4, 1, pixels.length], // StripByteCounts
    [284, 3, 1, 1],        // PlanarConfig
  ];
  // 레이아웃: [8B 헤더][픽셀데이터][IFD]
  const ifdOff = 8 + pixels.length;
  const ifdLen = 2 + entries.length * 12 + 4;
  const buf = new Uint8Array(ifdOff + ifdLen);
  const dv = new DataView(buf.buffer);
  buf[0] = 0x49; buf[1] = 0x49; dv.setUint16(2, 42, true); dv.setUint32(4, ifdOff, true);
  buf.set(pixels, 8);
  dv.setUint16(ifdOff, entries.length, true);
  entries.forEach((e, i) => {
    const o = ifdOff + 2 + i * 12;
    dv.setUint16(o, e[0], true); dv.setUint16(o + 2, e[1], true);
    dv.setUint32(o + 4, e[2], true); dv.setUint32(o + 8, e[3], true);
  });
  return buf;
}

describe("TIFF 디코더", () => {
  it("무압축 RGB TIFF 를 PNG data URI 로 변환한다", () => {
    // 2x1: 빨강, 초록
    const tif = makeTiff(2, 1, [255, 0, 0, 0, 255, 0]);
    const uri = tiffToPngDataUri(tif);
    expect(uri).toMatch(/^data:image\/png;base64,/);
    expect(uri!.length).toBeGreaterThan(60);
  });

  it("TIFF 가 아니면 null 을 반환한다", () => {
    expect(tiffToPngDataUri(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]))).toBeNull();
  });

  it("16bit 등 미지원 형식은 null(자리표시 폴백)", () => {
    const tif = makeTiff(1, 1, [0, 0, 0]);
    // BitsPerSample 을 16 으로 변조 → 미지원
    const dv = new DataView(tif.buffer);
    const ifdOff = dv.getUint32(4, true);
    // 258 태그(3번째 엔트리) 값 → 16
    dv.setUint32(ifdOff + 2 + 2 * 12 + 8, 16, true);
    expect(tiffToPngDataUri(tif)).toBeNull();
  });
});
