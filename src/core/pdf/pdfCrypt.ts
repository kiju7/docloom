/**
 * PDF 표준 보안 핸들러 — RC4(빈 사용자 암호) 복호화.
 *
 * 많은 PDF 가 "권한 제한"용으로 빈 사용자 암호로 **암호화**되어 있다. 복호화하지 않으면
 * 스트림·문자열이 깨진 바이트라 텍스트·이미지가 전혀 안 나온다. 여기서는 의존성 없이
 * MD5 + RC4 를 자체구현해 표준 보안 핸들러(Algorithm 2/4/5)로 파일키를 유도하고,
 * 객체별 키로 스트림/문자열을 복호한다.
 *
 * 지원: V1/V2, R2/R3 (RC4 40~128bit). 미지원: V4/V5(AESV2/AESV3) → 호출측이 감지해 안내.
 * (보안 노트: 이는 DRM 우회가 아니라 "빈 암호로 열리는" 합법 문서를 읽기 위함이다.)
 */

const PAD = new Uint8Array([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

// ── MD5 (RFC1321) ──────────────────────────────────────────────────────────
const MD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];
const MD5_T = [
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
  0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
  0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
  0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
  0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
  0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
  0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
  0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
];

export function md5(data: Uint8Array): Uint8Array {
  const len = data.length;
  const padLen = (Math.floor((len + 8) / 64) + 1) * 64;
  const msg = new Uint8Array(padLen);
  msg.set(data);
  msg[len] = 0x80;
  const bitLen = len * 8;
  // 64bit 길이(리틀엔디언). 비트수가 2^32 넘는 거대파일은 사실상 없음.
  msg[padLen - 8] = bitLen & 0xff;
  msg[padLen - 7] = (bitLen >>> 8) & 0xff;
  msg[padLen - 6] = (bitLen >>> 16) & 0xff;
  msg[padLen - 5] = (bitLen >>> 24) & 0xff;

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const M = new Int32Array(16);
  for (let off = 0; off < padLen; off += 64) {
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      M[i] = msg[j]! | (msg[j + 1]! << 8) | (msg[j + 2]! << 16) | (msg[j + 3]! << 24);
    }
    let a = a0, b = b0, c = c0, d = d0;
    for (let i = 0; i < 64; i++) {
      let f: number, g: number;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
      else { f = c ^ (b | ~d); g = (7 * i) % 16; }
      const x = (a + f + MD5_T[i]! + M[g]!) | 0;
      const s = MD5_S[i]!;
      const rot = (x << s) | (x >>> (32 - s));
      a = d; d = c; c = b;
      b = (b + rot) | 0;
    }
    a0 = (a0 + a) | 0; b0 = (b0 + b) | 0; c0 = (c0 + c) | 0; d0 = (d0 + d) | 0;
  }
  const out = new Uint8Array(16);
  const wr = (v: number, o: number) => {
    out[o] = v & 0xff; out[o + 1] = (v >>> 8) & 0xff; out[o + 2] = (v >>> 16) & 0xff; out[o + 3] = (v >>> 24) & 0xff;
  };
  wr(a0, 0); wr(b0, 4); wr(c0, 8); wr(d0, 12);
  return out;
}

// ── RC4 ─────────────────────────────────────────────────────────────────────
/** RC4 스트림 암호(대칭) — data 를 새 버퍼로 복호/암호화해 반환. */
export function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i]! + key[i % key.length]!) & 0xff;
    const t = s[i]!; s[i] = s[j]!; s[j] = t;
  }
  const out = new Uint8Array(data.length);
  let si = 0; j = 0;
  for (let k = 0; k < data.length; k++) {
    si = (si + 1) & 0xff;
    j = (j + s[si]!) & 0xff;
    const t = s[si]!; s[si] = s[j]!; s[j] = t;
    out[k] = data[k]! ^ s[(s[si]! + s[j]!) & 0xff]!;
  }
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export interface CryptParams {
  V: number;
  R: number;
  lengthBits: number;
  O: Uint8Array;
  U: Uint8Array;
  P: number;
  id0: Uint8Array;
  encryptMetadata: boolean;
  /** 스트림/문자열 암호 방식. "RC4" | "AESV2" | "AESV3" | "Identity". */
  cfm: string;
}

/** RC4 표준 보안 핸들러 — 빈 사용자 암호로 파일키를 유도. AES 는 미지원(active=false). */
export class PdfCrypt {
  active = false;
  unsupported = false; // AES 등 미지원 암호
  private keyLen: number;
  private fileKey = new Uint8Array(16);

  constructor(private p: CryptParams) {
    if (p.cfm === "AESV2" || p.cfm === "AESV3" || p.V >= 5) {
      this.unsupported = true;
      this.keyLen = 16;
      return;
    }
    let kl = Math.floor((p.lengthBits || 40) / 8);
    if (kl > 16) kl = 16;
    if (kl < 5) kl = 5;
    this.keyLen = kl;
    this.deriveKey();
  }

  /** Algorithm 2: MD5(pad || O || P(LE4) || ID0 [|| 0xFFFFFFFF]) → R>=3 이면 50회 더. */
  private deriveKey(): void {
    const pLE = new Uint8Array([this.p.P & 0xff, (this.p.P >>> 8) & 0xff, (this.p.P >>> 16) & 0xff, (this.p.P >>> 24) & 0xff]);
    let input = concat(PAD, this.p.O, pLE, this.p.id0);
    if (this.p.R >= 4 && !this.p.encryptMetadata) input = concat(input, new Uint8Array([0xff, 0xff, 0xff, 0xff]));
    let hash = md5(input);
    if (this.p.R >= 3) for (let i = 0; i < 50; i++) hash = md5(hash.subarray(0, this.keyLen));
    this.fileKey.set(hash.subarray(0, this.keyLen));
    this.active = true;
  }

  /** 객체별 키: MD5(fileKey || objNum(LE3) || gen(LE2))[:keyLen+5]. */
  private objectKey(num: number, gen: number): Uint8Array {
    const extra = new Uint8Array([num & 0xff, (num >>> 8) & 0xff, (num >>> 16) & 0xff, gen & 0xff, (gen >>> 8) & 0xff]);
    const hash = md5(concat(this.fileKey.subarray(0, this.keyLen), extra));
    const eff = Math.min(this.keyLen + 5, 16);
    return hash.subarray(0, eff);
  }

  /** 객체 num/gen 의 데이터(스트림/문자열) 복호. */
  decrypt(data: Uint8Array, num: number, gen: number): Uint8Array {
    if (!this.active || data.length === 0) return data;
    return rc4(this.objectKey(num, gen), data);
  }
}
