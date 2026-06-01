/**
 * AES(복호) + SHA-2 — PDF AESV2/AESV3 표준 보안 핸들러용 암호 프리미티브(의존성 없음).
 *
 * PDF 암호화의 큰 축이 AES 다(Acrobat 7+ = AESV2/RC4-style 키, Acrobat X+ = AESV3/SHA-2 키).
 * 복호하지 않으면 스트림·문자열이 깨진 바이트라 텍스트·이미지가 전혀 안 나온다. 여기선
 * AES-128/192/256 복호(CBC)와 SHA-256/384/512 를 자체구현한다. (DRM 우회가 아니라 빈 암호로
 * 합법적으로 열리는 문서를 읽기 위함.) 정확성은 FIPS-197/180 표준 테스트벡터로 검증.
 */

// ── AES S-box / 역 S-box ─────────────────────────────────────────────────────
const SBOX = buildSbox();
const INV_SBOX = (() => { const inv = new Uint8Array(256); for (let i = 0; i < 256; i++) inv[SBOX[i]!] = i; return inv; })();

function buildSbox(): Uint8Array {
  // GF(2^8) 곱·역원으로 S-box 동적 생성(거대 상수표 회피).
  const p = new Uint8Array(256), s = new Uint8Array(256);
  const mul = (a: number, b: number): number => { let r = 0; for (let i = 0; i < 8; i++) { if (b & 1) r ^= a; const hi = a & 0x80; a = (a << 1) & 0xff; if (hi) a ^= 0x1b; b >>= 1; } return r; };
  // 곱셈 역원표(브루트, 256개)
  const inv = new Uint8Array(256);
  for (let a = 1; a < 256; a++) for (let b = 1; b < 256; b++) if (mul(a, b) === 1) { inv[a] = b; break; }
  for (let i = 0; i < 256; i++) {
    let x = inv[i]!; let y = x;
    for (let k = 0; k < 4; k++) { y = ((y << 1) | (y >> 7)) & 0xff; x ^= y; }
    s[i] = x ^ 0x63;
  }
  void p;
  return s;
}

const xtime = (a: number): number => ((a << 1) ^ (a & 0x80 ? 0x11b : 0)) & 0xff;
const gmul = (a: number, b: number): number => { let r = 0; for (let i = 0; i < 8; i++) { if (b & 1) r ^= a; a = xtime(a); b >>= 1; } return r & 0xff; };

/** 키 확장 → 라운드키 워드(4바이트)들. Nk=키워드수(4/6/8), Nr=라운드수(10/12/14). */
function expandKey(key: Uint8Array): { rk: Uint8Array; Nr: number } {
  const Nk = key.length / 4;
  const Nr = Nk + 6;
  const total = 4 * (Nr + 1); // 워드 수
  const w = new Uint8Array(total * 4);
  w.set(key);
  let rcon = 1;
  for (let i = Nk; i < total; i++) {
    const o = i * 4;
    let t0 = w[o - 4]!, t1 = w[o - 3]!, t2 = w[o - 2]!, t3 = w[o - 1]!;
    if (i % Nk === 0) {
      // RotWord + SubWord + Rcon
      const r0 = SBOX[t1]!, r1 = SBOX[t2]!, r2 = SBOX[t3]!, r3 = SBOX[t0]!;
      t0 = r0 ^ rcon; t1 = r1; t2 = r2; t3 = r3;
      rcon = xtime(rcon);
    } else if (Nk > 6 && i % Nk === 4) {
      t0 = SBOX[t0]!; t1 = SBOX[t1]!; t2 = SBOX[t2]!; t3 = SBOX[t3]!;
    }
    w[o] = w[o - Nk * 4]! ^ t0;
    w[o + 1] = w[o - Nk * 4 + 1]! ^ t1;
    w[o + 2] = w[o - Nk * 4 + 2]! ^ t2;
    w[o + 3] = w[o - Nk * 4 + 3]! ^ t3;
  }
  return { rk: w, Nr };
}

/** 한 블록(16B) AES 복호(제자리). */
function decryptBlock(st: Uint8Array, rk: Uint8Array, Nr: number): void {
  const addRoundKey = (round: number): void => { const o = round * 16; for (let i = 0; i < 16; i++) st[i]! ^= rk[o + i]!; };
  const invSubBytes = (): void => { for (let i = 0; i < 16; i++) st[i] = INV_SBOX[st[i]!]!; };
  const invShiftRows = (): void => {
    const t = st.slice();
    // 열-주(column-major) 상태: st[r + 4c]. 역 ShiftRow: 행 r 을 오른쪽으로 r 칸.
    for (let r = 1; r < 4; r++) for (let c = 0; c < 4; c++) st[r + 4 * c] = t[r + 4 * ((c - r + 4) % 4)]!;
  };
  const invMixColumns = (): void => {
    for (let c = 0; c < 4; c++) {
      const o = c * 4, a0 = st[o]!, a1 = st[o + 1]!, a2 = st[o + 2]!, a3 = st[o + 3]!;
      st[o] = gmul(a0, 14) ^ gmul(a1, 11) ^ gmul(a2, 13) ^ gmul(a3, 9);
      st[o + 1] = gmul(a0, 9) ^ gmul(a1, 14) ^ gmul(a2, 11) ^ gmul(a3, 13);
      st[o + 2] = gmul(a0, 13) ^ gmul(a1, 9) ^ gmul(a2, 14) ^ gmul(a3, 11);
      st[o + 3] = gmul(a0, 11) ^ gmul(a1, 13) ^ gmul(a2, 9) ^ gmul(a3, 14);
    }
  };
  addRoundKey(Nr);
  for (let round = Nr - 1; round >= 1; round--) { invShiftRows(); invSubBytes(); addRoundKey(round); invMixColumns(); }
  invShiftRows(); invSubBytes(); addRoundKey(0);
}

/** 한 블록(16B) AES 암호(제자리) — R6 키유도(Algorithm 2.B)용. */
function encryptBlock(st: Uint8Array, rk: Uint8Array, Nr: number): void {
  const addRoundKey = (round: number): void => { const o = round * 16; for (let i = 0; i < 16; i++) st[i]! ^= rk[o + i]!; };
  const subBytes = (): void => { for (let i = 0; i < 16; i++) st[i] = SBOX[st[i]!]!; };
  const shiftRows = (): void => { const t = st.slice(); for (let r = 1; r < 4; r++) for (let c = 0; c < 4; c++) st[r + 4 * c] = t[r + 4 * ((c + r) % 4)]!; };
  const mixColumns = (): void => {
    for (let c = 0; c < 4; c++) {
      const o = c * 4, a0 = st[o]!, a1 = st[o + 1]!, a2 = st[o + 2]!, a3 = st[o + 3]!;
      st[o] = gmul(a0, 2) ^ gmul(a1, 3) ^ a2 ^ a3;
      st[o + 1] = a0 ^ gmul(a1, 2) ^ gmul(a2, 3) ^ a3;
      st[o + 2] = a0 ^ a1 ^ gmul(a2, 2) ^ gmul(a3, 3);
      st[o + 3] = gmul(a0, 3) ^ a1 ^ a2 ^ gmul(a3, 2);
    }
  };
  addRoundKey(0);
  for (let round = 1; round < Nr; round++) { subBytes(); shiftRows(); mixColumns(); addRoundKey(round); }
  subBytes(); shiftRows(); addRoundKey(Nr);
}

/** AES-CBC 암호(패딩 없음, data 길이는 16배수 가정). */
export function aesCbcEncrypt(key: Uint8Array, data: Uint8Array, iv: Uint8Array): Uint8Array {
  const { rk, Nr } = expandKey(key);
  const n = data.length - (data.length % 16);
  const out = new Uint8Array(n);
  let prev = iv;
  for (let off = 0; off < n; off += 16) {
    const block = data.slice(off, off + 16);
    for (let i = 0; i < 16; i++) block[i]! ^= prev[i]!;
    encryptBlock(block, rk, Nr);
    out.set(block, off);
    prev = block;
  }
  return out;
}

/**
 * PDF 2.0 (R6) 키유도 해시 — Algorithm 2.B. password ‖ salt ‖ udata 로 시작해
 * AES-128-CBC 암호와 SHA-256/384/512 를 라운드마다 번갈아 적용(하드닝). 32바이트 반환.
 */
export function hash2B(password: Uint8Array, salt: Uint8Array, udata: Uint8Array): Uint8Array {
  let K = sha256(concat(password, salt, udata));
  for (let round = 0; ; round++) {
    const seq = concat(password, K, udata);
    const K1 = new Uint8Array(seq.length * 64);
    for (let i = 0; i < 64; i++) K1.set(seq, i * seq.length);
    const E = aesCbcEncrypt(K.subarray(0, 16), K1, K.subarray(16, 32));
    let mod = 0; for (let i = 0; i < 16; i++) mod += E[i]!; mod %= 3;
    K = mod === 0 ? sha256(E) : mod === 1 ? sha384(E) : sha512(E);
    if (round >= 63 && E[E.length - 1]! <= round - 32) break;
  }
  return K.subarray(0, 32);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  let n = 0; for (const p of parts) n += p.length;
  const out = new Uint8Array(n); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** AES-CBC 복호. iv 명시 안 하면 data 앞 16바이트를 IV 로 본다(PDF 규약). pad 제거 옵션. */
export function aesCbcDecrypt(key: Uint8Array, data: Uint8Array, opts: { iv?: Uint8Array; removePadding?: boolean } = {}): Uint8Array {
  const { rk, Nr } = expandKey(key);
  let iv: Uint8Array, ct: Uint8Array;
  if (opts.iv) { iv = opts.iv; ct = data; }
  else { iv = data.subarray(0, 16); ct = data.subarray(16); }
  const n = ct.length - (ct.length % 16);
  const out = new Uint8Array(n);
  let prev = iv;
  for (let off = 0; off < n; off += 16) {
    const block = ct.slice(off, off + 16);
    const dec = block.slice();
    decryptBlock(dec, rk, Nr);
    for (let i = 0; i < 16; i++) dec[i]! ^= prev[i]!;
    out.set(dec, off);
    prev = block;
  }
  if (opts.removePadding && n > 0) {
    const padLen = out[n - 1]!;
    if (padLen >= 1 && padLen <= 16) return out.subarray(0, n - padLen);
  }
  return out;
}

// ── SHA-256 (FIPS-180) ───────────────────────────────────────────────────────
const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
export function sha256(data: Uint8Array): Uint8Array {
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const l = data.length, padLen = ((l + 8) >> 6) + 1 << 6 < l + 9 ? 0 : 0;
  void padLen;
  const msgLen = (((l + 8) >> 6) + 1) * 64;
  const m = new Uint8Array(msgLen); m.set(data); m[l] = 0x80;
  const bits = l * 8; const dv = new DataView(m.buffer);
  dv.setUint32(msgLen - 4, bits >>> 0); dv.setUint32(msgLen - 8, Math.floor(bits / 0x100000000));
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < msgLen; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) | 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e!, 6) ^ rotr(e!, 11) ^ rotr(e!, 25);
      const ch = (e! & f!) ^ (~e! & g!);
      const t1 = (h! + S1 + ch + K256[i]! + w[i]!) | 0;
      const S0 = rotr(a!, 2) ^ rotr(a!, 13) ^ rotr(a!, 22);
      const maj = (a! & b!) ^ (a! & c!) ^ (b! & c!);
      const t2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d! + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H[0] = (H[0]! + a!) | 0; H[1] = (H[1]! + b!) | 0; H[2] = (H[2]! + c!) | 0; H[3] = (H[3]! + d!) | 0;
    H[4] = (H[4]! + e!) | 0; H[5] = (H[5]! + f!) | 0; H[6] = (H[6]! + g!) | 0; H[7] = (H[7]! + h!) | 0;
  }
  const out = new Uint8Array(32); new DataView(out.buffer);
  for (let i = 0; i < 8; i++) { out[i * 4] = H[i]! >>> 24; out[i * 4 + 1] = (H[i]! >>> 16) & 0xff; out[i * 4 + 2] = (H[i]! >>> 8) & 0xff; out[i * 4 + 3] = H[i]! & 0xff; }
  return out;
}

// ── SHA-512 / SHA-384 (BigInt, 64bit) ────────────────────────────────────────
const MASK64 = (1n << 64n) - 1n;
const K512 = [
  "428a2f98d728ae22", "7137449123ef65cd", "b5c0fbcfec4d3b2f", "e9b5dba58189dbbc", "3956c25bf348b538", "59f111f1b605d019", "923f82a4af194f9b", "ab1c5ed5da6d8118",
  "d807aa98a3030242", "12835b0145706fbe", "243185be4ee4b28c", "550c7dc3d5ffb4e2", "72be5d74f27b896f", "80deb1fe3b1696b1", "9bdc06a725c71235", "c19bf174cf692694",
  "e49b69c19ef14ad2", "efbe4786384f25e3", "0fc19dc68b8cd5b5", "240ca1cc77ac9c65", "2de92c6f592b0275", "4a7484aa6ea6e483", "5cb0a9dcbd41fbd4", "76f988da831153b5",
  "983e5152ee66dfab", "a831c66d2db43210", "b00327c898fb213f", "bf597fc7beef0ee4", "c6e00bf33da88fc2", "d5a79147930aa725", "06ca6351e003826f", "142929670a0e6e70",
  "27b70a8546d22ffc", "2e1b21385c26c926", "4d2c6dfc5ac42aed", "53380d139d95b3df", "650a73548baf63de", "766a0abb3c77b2a8", "81c2c92e47edaee6", "92722c851482353b",
  "a2bfe8a14cf10364", "a81a664bbc423001", "c24b8b70d0f89791", "c76c51a30654be30", "d192e819d6ef5218", "d69906245565a910", "f40e35855771202a", "106aa07032bbd1b8",
  "19a4c116b8d2d0c8", "1e376c085141ab53", "2748774cdf8eeb99", "34b0bcb5e19b48a8", "391c0cb3c5c95a63", "4ed8aa4ae3418acb", "5b9cca4f7763e373", "682e6ff3d6b2b8a3",
  "748f82ee5defb2fc", "78a5636f43172f60", "84c87814a1f0ab72", "8cc702081a6439ec", "90befffa23631e28", "a4506cebde82bde9", "bef9a3f7b2c67915", "c67178f2e372532b",
  "ca273eceea26619c", "d186b8c721c0c207", "eada7dd6cde0eb1e", "f57d4f7fee6ed178", "06f067aa72176fba", "0a637dc5a2c898a6", "113f9804bef90dae", "1b710b35131c471b",
  "28db77f523047d84", "32caab7b40c72493", "3c9ebe0a15c9bebc", "431d67c49c100d4c", "4cc5d4becb3e42b6", "597f299cfc657e2a", "5fcb6fab3ad6faec", "6c44198c4a475817",
].map((h) => BigInt("0x" + h));

function sha512core(data: Uint8Array, H: bigint[], outBytes: number): Uint8Array {
  const rotr = (x: bigint, n: bigint): bigint => ((x >> n) | (x << (64n - n))) & MASK64;
  const l = data.length;
  const msgLen = (Math.floor((l + 16) / 128) + 1) * 128;
  const m = new Uint8Array(msgLen); m.set(data); m[l] = 0x80;
  const bits = BigInt(l) * 8n;
  for (let i = 0; i < 16; i++) m[msgLen - 1 - i] = Number((bits >> BigInt(8 * i)) & 0xffn);
  const w = new Array<bigint>(80);
  for (let off = 0; off < msgLen; off += 128) {
    for (let i = 0; i < 16; i++) { let v = 0n; for (let k = 0; k < 8; k++) v = (v << 8n) | BigInt(m[off + i * 8 + k]!); w[i] = v; }
    for (let i = 16; i < 80; i++) {
      const s0 = rotr(w[i - 15]!, 1n) ^ rotr(w[i - 15]!, 8n) ^ (w[i - 15]! >> 7n);
      const s1 = rotr(w[i - 2]!, 19n) ^ rotr(w[i - 2]!, 61n) ^ (w[i - 2]! >> 6n);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) & MASK64;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 80; i++) {
      const S1 = rotr(e!, 14n) ^ rotr(e!, 18n) ^ rotr(e!, 41n);
      const ch = (e! & f!) ^ (~e! & MASK64 & g!);
      const t1 = (h! + S1 + ch + K512[i]! + w[i]!) & MASK64;
      const S0 = rotr(a!, 28n) ^ rotr(a!, 34n) ^ rotr(a!, 39n);
      const maj = (a! & b!) ^ (a! & c!) ^ (b! & c!);
      const t2 = (S0 + maj) & MASK64;
      h = g; g = f; f = e; e = (d! + t1) & MASK64; d = c; c = b; b = a; a = (t1 + t2) & MASK64;
    }
    H[0] = (H[0]! + a!) & MASK64; H[1] = (H[1]! + b!) & MASK64; H[2] = (H[2]! + c!) & MASK64; H[3] = (H[3]! + d!) & MASK64;
    H[4] = (H[4]! + e!) & MASK64; H[5] = (H[5]! + f!) & MASK64; H[6] = (H[6]! + g!) & MASK64; H[7] = (H[7]! + h!) & MASK64;
  }
  const out = new Uint8Array(64);
  for (let i = 0; i < 8; i++) for (let k = 0; k < 8; k++) out[i * 8 + k] = Number((H[i]! >> BigInt(56 - 8 * k)) & 0xffn);
  return out.subarray(0, outBytes);
}
export function sha512(data: Uint8Array): Uint8Array {
  return sha512core(data, ["6a09e667f3bcc908", "bb67ae8584caa73b", "3c6ef372fe94f82b", "a54ff53a5f1d36f1", "510e527fade682d1", "9b05688c2b3e6c1f", "1f83d9abfb41bd6b", "5be0cd19137e2179"].map((h) => BigInt("0x" + h)), 64);
}
export function sha384(data: Uint8Array): Uint8Array {
  return sha512core(data, ["cbbb9d5dc1059ed8", "629a292a367cd507", "9159015a3070dd17", "152fecd8f70e5939", "67332667ffc00b31", "8eb44a8768581511", "db0c2e0d64f98fa7", "47b5481dbefa4fa4"].map((h) => BigInt("0x" + h)), 48);
}
