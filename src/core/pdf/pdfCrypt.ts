/**
 * PDF 표준 보안 핸들러 — RC4(빈 사용자 암호) 복호화.
 *
 * 많은 PDF 가 "권한 제한"용으로 빈 사용자 암호로 **암호화**되어 있다. 복호화하지 않으면
 * 스트림·문자열이 깨진 바이트라 텍스트·이미지가 전혀 안 나온다. 여기서는 의존성 없이
 * MD5 + RC4 를 자체구현해 표준 보안 핸들러(Algorithm 2/4/5)로 파일키를 유도하고,
 * 객체별 키로 스트림/문자열을 복호한다.
 *
 * 지원: V1/V2(RC4 40~128bit), V4(AESV2/RC4), V5·R5/R6(AESV3, AES-256). 빈 사용자 암호 한정.
 * (보안 노트: 이는 DRM 우회가 아니라 "빈 암호로 열리는" 합법 문서를 읽기 위함이다.)
 */
import { aesCbcDecrypt, sha256, hash2B } from "./pdfAes.js";

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
  /** V5(AESV3) 파일키 복호용 — 사용자 암호로 감싼 키. */
  UE?: Uint8Array;
  P: number;
  id0: Uint8Array;
  encryptMetadata: boolean;
  /** 스트림/문자열 암호 방식. "RC4" | "AESV2" | "AESV3" | "Identity". */
  cfm: string;
}

const SALT_AES = new Uint8Array([0x73, 0x41, 0x6c, 0x54]); // "sAlT"

/**
 * 표준 보안 핸들러(빈 사용자 암호). RC4(V1/2) + AESV2(V4) + AESV3(V5/R5·R6) 복호.
 * 빈 암호로 안 열리는(진짜 암호 보호) 문서는 unsupported 로 표시한다.
 */
export class PdfCrypt {
  active = false;
  unsupported = false;
  private keyLen: number;
  private fileKey = new Uint8Array(32);
  private mode: "rc4" | "aes128" | "aes256";

  constructor(private p: CryptParams) {
    if (p.V >= 5 || p.cfm === "AESV3") {
      this.mode = "aes256"; this.keyLen = 32; this.deriveKeyV5(); return;
    }
    if (p.cfm === "AESV2") {
      this.mode = "aes128"; this.keyLen = 16; this.deriveKey(); return;
    }
    this.mode = "rc4";
    let kl = Math.floor((p.lengthBits || 40) / 8);
    if (kl > 16) kl = 16;
    if (kl < 5) kl = 5;
    this.keyLen = kl;
    this.deriveKey();
  }

  /** Algorithm 2 (RC4·AESV2): MD5(pad || O || P(LE4) || ID0 [|| 0xFFFFFFFF]) → R>=3 이면 50회 더. */
  private deriveKey(): void {
    const pLE = new Uint8Array([this.p.P & 0xff, (this.p.P >>> 8) & 0xff, (this.p.P >>> 16) & 0xff, (this.p.P >>> 24) & 0xff]);
    let input = concat(PAD, this.p.O, pLE, this.p.id0);
    if (this.p.R >= 4 && !this.p.encryptMetadata) input = concat(input, new Uint8Array([0xff, 0xff, 0xff, 0xff]));
    let hash = md5(input);
    if (this.p.R >= 3) for (let i = 0; i < 50; i++) hash = md5(hash.subarray(0, this.keyLen));
    this.fileKey.set(hash.subarray(0, this.keyLen));
    this.active = true;
  }

  /** Algorithm 2.A/2.B (AESV3): 빈 사용자 암호 검증 후 UE 를 풀어 32바이트 파일키 획득. */
  private deriveKeyV5(): void {
    const U = this.p.U, UE = this.p.UE;
    if (!U || U.length < 48 || !UE || UE.length < 32) { this.unsupported = true; return; }
    const pw = new Uint8Array(0), empty = new Uint8Array(0);
    const valSalt = U.subarray(32, 40), keySalt = U.subarray(40, 48);
    const r6 = this.p.R >= 6;
    const hash = (salt: Uint8Array): Uint8Array => (r6 ? hash2B(pw, salt, empty) : sha256(concat(pw, salt)));
    // 빈 사용자 암호 검증: hash(pw, validationSalt) == U[0:32] 이어야 빈 암호로 열린다.
    const v = hash(valSalt);
    for (let i = 0; i < 32; i++) if (v[i] !== U[i]) { this.unsupported = true; return; }
    // 파일키 = AES-256-CBC(IV=0, no-pad) 로 UE 를 푼다(중간키 = hash(pw, keySalt)).
    const ikey = hash(keySalt);
    const fk = aesCbcDecrypt(ikey, UE.subarray(0, 32), { iv: new Uint8Array(16) });
    this.fileKey.set(fk.subarray(0, 32));
    this.active = true;
  }

  /** 객체별 키(RC4·AESV2): MD5(fileKey || objNum(LE3) || gen(LE2) [|| sAlT])[:keyLen+5]. */
  private objectKey(num: number, gen: number, aes: boolean): Uint8Array {
    const extra = new Uint8Array([num & 0xff, (num >>> 8) & 0xff, (num >>> 16) & 0xff, gen & 0xff, (gen >>> 8) & 0xff]);
    const parts = [this.fileKey.subarray(0, this.keyLen), extra];
    if (aes) parts.push(SALT_AES);
    const hash = md5(concat(...parts));
    return hash.subarray(0, Math.min(this.keyLen + 5, 16));
  }

  /** 객체 num/gen 의 데이터(스트림/문자열) 복호. */
  decrypt(data: Uint8Array, num: number, gen: number): Uint8Array {
    if (!this.active || data.length === 0) return data;
    if (this.mode === "rc4") return rc4(this.objectKey(num, gen, false), data);
    if (this.mode === "aes128") return aesCbcDecrypt(this.objectKey(num, gen, true), data, { removePadding: true });
    return aesCbcDecrypt(this.fileKey.subarray(0, 32), data, { removePadding: true }); // aes256: 파일키 직접
  }
}
