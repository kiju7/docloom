/**
 * 브라우저·Node 양쪽에서 동작하는 순수 base64 인코더.
 * (Node 전용 Buffer 에 의존하지 않기 위해 직접 구현 — 이미지 data URI 생성에 쓴다.
 *  base64 는 무손실 가역 인코딩이다: 바이트 ↔ 문자 1:1. 크기만 ~33% 늘 뿐 데이터 손실 없음.)
 */
const TABLE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
/** 인덱스→출력 ASCII 바이트(문자코드). 출력 버퍼에 바로 써넣어 임시 문자열 생성을 없앤다. */
const ENC = Uint8Array.from(TABLE, (ch) => ch.charCodeAt(0));
const PAD = 0x3d; // '='
const latin1Dec = new TextDecoder("latin1");

export function bytesToBase64(bytes: Uint8Array): string {
  const len = bytes.length;
  const out = new Uint8Array(Math.ceil(len / 3) * 4);
  let o = 0;
  let i = 0;
  for (; i + 2 < len; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out[o++] = ENC[(n >> 18) & 63]!;
    out[o++] = ENC[(n >> 12) & 63]!;
    out[o++] = ENC[(n >> 6) & 63]!;
    out[o++] = ENC[n & 63]!;
  }
  const rem = len - i;
  if (rem === 1) {
    const n = bytes[i]! << 16;
    out[o++] = ENC[(n >> 18) & 63]!;
    out[o++] = ENC[(n >> 12) & 63]!;
    out[o++] = PAD;
    out[o++] = PAD;
  } else if (rem === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out[o++] = ENC[(n >> 18) & 63]!;
    out[o++] = ENC[(n >> 12) & 63]!;
    out[o++] = ENC[(n >> 6) & 63]!;
    out[o++] = PAD;
  }
  // base64 출력은 전부 ASCII(<128) → latin1 디코드로 단번에 문자열화(임시 문자열 0개).
  return latin1Dec.decode(out);
}

const DECODE = (() => {
  const m = new Int16Array(128).fill(-1);
  for (let i = 0; i < TABLE.length; i++) m[TABLE.charCodeAt(i)] = i;
  return m;
})();

/** base64 문자열 → 바이트. (bytesToBase64 의 역연산. 공백/개행/패딩은 무시) */
export function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, "");
  const out = new Uint8Array(Math.floor((clean.length * 6) / 8));
  let buffer = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < clean.length; i++) {
    buffer = (buffer << 6) | DECODE[clean.charCodeAt(i)]!;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (buffer >> bits) & 0xff;
    }
  }
  return out.subarray(0, o);
}
