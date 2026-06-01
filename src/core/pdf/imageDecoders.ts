/**
 * 플러그형 이미지 디코더 훅.
 *
 * docloom 코어는 JPEG(DCT)·PNG(Flate/raw)·CCITTFax 만 내장한다(가벼움 유지). JPEG2000(JPX)·
 * JBIG2 처럼 디코더가 거대한 포맷은 **사용자가 외부 라이브러리를 붙여** 처리한다.
 *
 * 동기 유지 전략: previewHtml/buildImage 는 동기다. WASM 라이브러리(openjpeg 등)는 초기화가
 * 비동기지만 **초기화는 미리 끝내두고**(앱 시작 시), 등록하는 decode 함수 자체는 동기로 둔다.
 *
 *   import { registerImageDecoder } from "docloom";
 *   await openjpeg.ready;                       // 라이브러리 비동기 초기화는 앱에서
 *   registerImageDecoder("JPXDecode", (bytes, info) => {
 *     const { data, width, height } = openjpeg.decode(bytes); // 동기 호출
 *     return { pixels: data, channels: 4, width, height };
 *   });
 *
 * 등록된 필터는 코어가 자동으로 호출한다. 미등록이면 기존대로 자리표시 박스.
 */

/** 디코더가 받는 이미지 메타. */
export interface ImageDecodeInfo {
  /** 이 디코더를 부른 /Filter 이름(예 "JPXDecode"). */
  filter: string;
  width: number;
  height: number;
  bitsPerComponent: number;
  /** 색공간 이름 힌트(있으면). DeviceRGB/DeviceGray/DeviceCMYK/ICCBased… */
  colorSpace?: string;
  /** ImageMask 여부. */
  isMask: boolean;
  /** 마스크 채움색 [r,g,b] 0–255. */
  fill: [number, number, number];
  /** JBIG2 의 /JBIG2Globals 스트림(공유 세그먼트) — 있으면 디코드된 바이트. */
  globals?: Uint8Array;
}

/** 디코더 결과: 픽셀(코어가 PNG 인코드) 또는 완성된 data URI. */
export interface DecodedImage {
  width: number;
  height: number;
  /** RGB(3) 또는 RGBA(4) 픽셀(width*height*channels). channels 생략 시 길이로 추정. */
  pixels?: Uint8Array;
  channels?: 3 | 4;
  /** 또는 바로 쓸 data URI(image/png·image/jpeg). 주어지면 pixels 보다 우선. */
  uri?: string;
}

export type ImageDecoder = (data: Uint8Array, info: ImageDecodeInfo) => DecodedImage | null;

const registry = new Map<string, ImageDecoder>();

/** 필터 이름(예 "JPXDecode","JBIG2Decode")에 디코더를 등록. 같은 이름 재등록은 덮어씀. */
export function registerImageDecoder(filter: string, decoder: ImageDecoder): void {
  registry.set(filter, decoder);
}

/** 등록 해제. */
export function unregisterImageDecoder(filter: string): void {
  registry.delete(filter);
}

/** 전부 해제(테스트용). */
export function clearImageDecoders(): void {
  registry.clear();
}

export function getImageDecoder(filter: string): ImageDecoder | undefined {
  return registry.get(filter);
}
