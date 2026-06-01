/**
 * CCITTFax(Group 3/4 팩스) 디코더 — 스캔 흑백문서 이미지.
 *
 * JDoc(src/pdf.cpp) 의 룩업테이블 방식 포팅: 8bit(백)/7bit(흑)/7bit(2D) 선두 룩업 후
 * 확장. G3 1D(K=0)·G4 2D(K<0) 지원. 출력은 1bit/픽셀 패킹, **1=흑**(ITU 관례).
 * 호출측(pdfImages)이 BlackIs1·ImageMask 를 반영해 픽셀로 펼친다.
 */

// HuffNode = [val, nbits]. 공백구분 "val,nbits" 쌍 문자열을 파싱(C++ 초기화자와 1:1).
function parseTable(s: string): Int16Array {
  const nums = s.trim().split(/\s+/).flatMap((p) => p.split(",").map(Number));
  return Int16Array.from(nums);
}

// 2D 모드 코드
const PASS = -4, HORIZ = -5, V0 = 3, VR1 = 2, VR2 = 1, VR3 = 0, VL1 = 4, VL2 = 5, VL3 = 6;

const W = parseTable(`
256,12 272,12 29,8 30,8 45,8 46,8 22,7 22,7
23,7 23,7 47,8 48,8 13,6 13,6 13,6 13,6 20,7
20,7 33,8 34,8 35,8 36,8 37,8 38,8 19,7 19,7
31,8 32,8 1,6 1,6 1,6 1,6 12,6 12,6 12,6 12,6
53,8 54,8 26,7 26,7 39,8 40,8 41,8 42,8 43,8
44,8 21,7 21,7 28,7 28,7 61,8 62,8 63,8 0,8
320,8 384,8 10,5 10,5 10,5 10,5 10,5 10,5 10,5
10,5 11,5 11,5 11,5 11,5 11,5 11,5 11,5 11,5
27,7 27,7 59,8 60,8 288,9 290,9 18,7 18,7 24,7
24,7 49,8 50,8 51,8 52,8 25,7 25,7 55,8 56,8
57,8 58,8 192,6 192,6 192,6 192,6 1664,6 1664,6
1664,6 1664,6 448,8 512,8 292,9 640,8 576,8 294,9
296,9 298,9 300,9 302,9 256,7 256,7 2,4 2,4 2,4
2,4 2,4 2,4 2,4 2,4 2,4 2,4 2,4 2,4 2,4 2,4
2,4 2,4 3,4 3,4 3,4 3,4 3,4 3,4 3,4 3,4 3,4
3,4 3,4 3,4 3,4 3,4 3,4 3,4 128,5 128,5 128,5
128,5 128,5 128,5 128,5 128,5 8,5 8,5 8,5 8,5
8,5 8,5 8,5 8,5 9,5 9,5 9,5 9,5 9,5 9,5 9,5
9,5 16,6 16,6 16,6 16,6 17,6 17,6 17,6 17,6
4,4 4,4 4,4 4,4 4,4 4,4 4,4 4,4 4,4 4,4 4,4
4,4 4,4 4,4 4,4 4,4 5,4 5,4 5,4 5,4 5,4 5,4
5,4 5,4 5,4 5,4 5,4 5,4 5,4 5,4 5,4 5,4
14,6 14,6 14,6 14,6 15,6 15,6 15,6 15,6 64,5
64,5 64,5 64,5 64,5 64,5 64,5 64,5 6,4 6,4
6,4 6,4 6,4 6,4 6,4 6,4 6,4 6,4 6,4 6,4 6,4
6,4 6,4 6,4 7,4 7,4 7,4 7,4 7,4 7,4 7,4 7,4
7,4 7,4 7,4 7,4 7,4 7,4 7,4 7,4 -2,3 -2,3
-1,0 -1,0 -1,0 -1,0 -1,0 -1,0 -1,0 -1,0 -1,0
-1,0 -1,0 -1,0 -1,0 -3,4 1792,3 1792,3 1984,4
2048,4 2112,4 2176,4 2240,4 2304,4 1856,3 1856,3
1920,3 1920,3 2368,4 2432,4 2496,4 2560,4 1472,1
1536,1 1600,1 1728,1 704,1 768,1 832,1 896,1
960,1 1024,1 1088,1 1152,1 1216,1 1280,1 1344,1
1408,1`);

const B = parseTable(`
128,12 160,13 224,12 256,12 10,7 11,7 288,12 12,7
9,6 9,6 8,6 8,6 7,5 7,5 7,5 7,5 6,4 6,4 6,4
6,4 6,4 6,4 6,4 6,4 5,4 5,4 5,4 5,4 5,4 5,4
5,4 5,4 1,3 1,3 1,3 1,3 1,3 1,3 1,3 1,3 1,3
1,3 1,3 1,3 1,3 1,3 1,3 1,3 4,3 4,3 4,3 4,3
4,3 4,3 4,3 4,3 4,3 4,3 4,3 4,3 4,3 4,3 4,3
4,3 3,2 3,2 3,2 3,2 3,2 3,2 3,2 3,2 3,2 3,2
3,2 3,2 3,2 3,2 3,2 3,2 3,2 3,2 3,2 3,2 3,2
3,2 3,2 3,2 3,2 3,2 3,2 3,2 3,2 3,2 3,2 3,2
2,2 2,2 2,2 2,2 2,2 2,2 2,2 2,2 2,2 2,2 2,2
2,2 2,2 2,2 2,2 2,2 2,2 2,2 2,2 2,2 2,2 2,2
2,2 2,2 2,2 2,2 2,2 2,2 2,2 2,2 2,2 2,2
-2,4 -2,4 -1,0 -1,0 -1,0 -1,0 -1,0 -1,0 -1,0
-1,0 -1,0 -1,0 -1,0 -1,0 -1,0 -3,5 1792,4
1792,4 1984,5 2048,5 2112,5 2176,5 2240,5 2304,5
1856,4 1856,4 1920,4 1920,4 2368,5 2432,5 2496,5
2560,5 18,3 18,3 18,3 18,3 18,3 18,3 18,3 18,3
52,5 52,5 640,6 704,6 768,6 832,6 55,5 55,5
56,5 56,5 1280,6 1344,6 1408,6 1472,6 59,5 59,5
60,5 60,5 1536,6 1600,6 24,4 24,4 24,4 24,4
25,4 25,4 25,4 25,4 1664,6 1728,6 320,5 320,5
384,5 384,5 448,5 448,5 512,6 576,6 53,5 53,5
54,5 54,5 896,6 960,6 1024,6 1088,6 1152,6 1216,6
64,3 64,3 64,3 64,3 64,3 64,3 64,3 64,3 13,1
13,1 13,1 13,1 13,1 13,1 13,1 13,1 13,1 13,1
13,1 13,1 13,1 13,1 13,1 13,1 23,4 23,4 50,5
51,5 44,5 45,5 46,5 47,5 57,5 58,5 61,5 256,5
16,3 16,3 16,3 16,3 17,3 17,3 17,3 17,3 48,5
49,5 62,5 63,5 30,5 31,5 32,5 33,5 40,5 41,5
22,4 22,4 14,1 14,1 14,1 14,1 14,1 14,1 14,1
14,1 14,1 14,1 14,1 14,1 14,1 14,1 14,1 14,1
15,2 15,2 15,2 15,2 15,2 15,2 15,2 15,2 128,5
192,5 26,5 27,5 28,5 29,5 19,4 19,4 20,4 20,4
34,5 35,5 36,5 37,5 38,5 39,5 21,4 21,4 42,5
43,5 0,3 0,3 0,3 0,3`);

const D2 = parseTable(`
128,11 144,10 6,7 0,7 5,6 5,6 1,6 1,6 -4,4
-4,4 -4,4 -4,4 -4,4 -4,4 -4,4 -4,4 -5,3 -5,3
-5,3 -5,3 -5,3 -5,3 -5,3 -5,3 -5,3 -5,3 -5,3
-5,3 -5,3 -5,3 -5,3 -5,3 4,3 4,3 4,3 4,3 4,3
4,3 4,3 4,3 4,3 4,3 4,3 4,3 4,3 4,3 4,3 4,3
2,3 2,3 2,3 2,3 2,3 2,3 2,3 2,3 2,3 2,3 2,3
2,3 2,3 2,3 2,3 2,3 3,1 3,1 3,1 3,1 3,1 3,1
3,1 3,1 3,1 3,1 3,1 3,1 3,1 3,1 3,1 3,1 3,1
3,1 3,1 3,1 3,1 3,1 3,1 3,1 3,1 3,1 3,1 3,1
3,1 3,1 3,1 3,1 3,1 3,1 3,1 3,1 3,1 3,1 3,1
3,1 3,1 3,1 3,1 3,1 3,1 3,1 3,1 3,1 3,1 3,1
3,1 3,1 3,1 3,1 3,1 3,1 3,1 3,1 3,1 3,1 3,1
3,1 3,1 3,1 -2,4 -1,0 -1,0 -1,0 -1,0 -1,0
-1,0 -1,0 -1,0 -1,0 -1,0 -1,0 -1,0 -1,0 -1,0
-1,0 -1,0 -1,0 -1,0 -1,0 -1,0 -1,0 -1,0 -3,3`);

const CLZ = (() => {
  const t = new Uint8Array(256);
  for (let i = 0; i < 256; i++) { let n = 0, v = i; while (v < 128 && n < 8) { n++; v <<= 1; } t[i] = i === 0 ? 8 : n; }
  return t;
})();
const TAIL = [0x7f, 0x3f, 0x1f, 0x0f, 0x07, 0x03, 0x01, 0x00];
const LMASK = [0xff, 0x7f, 0x3f, 0x1f, 0x0f, 0x07, 0x03, 0x01];
const RMASK = [0x00, 0x80, 0xc0, 0xe0, 0xf0, 0xf8, 0xfc, 0xfe];

const getBit = (line: Uint8Array, x: number): number => (line[x >> 3]! >> (7 - (x & 7))) & 1;

function setBits(line: Uint8Array, x0: number, x1: number): void {
  if (x1 <= x0) return;
  const a0 = x0 >> 3, a1 = x1 >> 3, b0 = x0 & 7, b1 = x1 & 7;
  if (a0 === a1) { if (b1) line[a0]! |= LMASK[b0]! & RMASK[b1]!; }
  else {
    line[a0]! |= LMASK[b0]!;
    for (let a = a0 + 1; a < a1; a++) line[a] = 0xff;
    if (b1) line[a1]! |= RMASK[b1]!;
  }
}

function nextEdge(line: Uint8Array, x: number, w: number): number {
  let m: number;
  if (x < 0) { x = 0; m = 0xff; } else m = TAIL[x & 7]!;
  const Wb = w >> 3;
  let xb = x >> 3;
  let a = line[xb]!;
  let b = (a ^ (a >> 1)) & m;
  if (xb >= Wb) { const r = (xb << 3) + CLZ[b]!; return r > w ? w : r; }
  while (b === 0) {
    if (++xb >= Wb) {
      if ((xb << 3) === w) return w;
      const prev = a & 1; a = line[xb]!; b = ((prev << 7) ^ a ^ (a >> 1)) & 0xff;
      const r = (xb << 3) + CLZ[b]!; return r > w ? w : r;
    }
    const prev = a & 1; a = line[xb]!; b = ((prev << 7) ^ a ^ (a >> 1)) & 0xff;
  }
  return (xb << 3) + CLZ[b]!;
}

function nextColorEdge(line: Uint8Array, x: number, w: number, color: number): number {
  if (x >= w) return w;
  x = nextEdge(line, x > 0 || !color ? x : -1, w);
  if (x < w && getBit(line, x) !== color) x = nextEdge(line, x, w);
  return x;
}

class BitStream {
  word = 0;
  bidx = 32;
  pos = 0;
  constructor(public src: Uint8Array) { this.fill(); }
  fill(): void {
    while (this.bidx > 19 && this.pos < this.src.length) {
      this.bidx -= 8;
      this.word = (this.word | (this.src[this.pos++]! << this.bidx)) >>> 0;
    }
  }
  eat(n: number): void { this.word = (this.word << n) >>> 0; this.bidx += n; }
  getCode(table: Int16Array, initialBits: number): number {
    this.fill();
    let tidx = this.word >>> (32 - initialBits);
    let val = table[tidx * 2]!;
    let nbits = table[tidx * 2 + 1]!;
    if (nbits > initialBits) {
      const wordmask = ((1 << (32 - initialBits)) - 1) >>> 0;
      tidx = val + (((this.word & wordmask) >>> 0) >>> (32 - nbits));
      val = table[tidx * 2]!;
      nbits = initialBits + table[tidx * 2 + 1]!;
    }
    this.eat(nbits);
    return val;
  }
  getRun(color: number): number {
    let total = 0;
    for (;;) {
      const code = color === 0 ? this.getCode(W, 8) : this.getCode(B, 7);
      if (code < 0) return total;
      total += code;
      if (code < 64) break;
    }
    return total;
  }
}

/** CCITT 디코드 → 1bit 패킹 행들(1=흑). columns·k(0=G3,<0=G4). */
export function decodeCcitt(src: Uint8Array, k: number, columns: number, rows: number): Uint8Array {
  if (columns <= 0) columns = 1728;
  const stride = (columns + 7) >> 3;
  const st = new BitStream(src);
  let ref = new Uint8Array(stride);
  const outRows: Uint8Array[] = [];
  let maxRows = rows > 0 ? rows : 100000;

  if (k === 0) {
    while (maxRows-- > 0 && st.pos < st.src.length) {
      const dst = new Uint8Array(stride);
      let a = 0, c = 0;
      while (a < columns) {
        const run = st.getRun(c);
        if (run < 0) break;
        if (c) setBits(dst, a, Math.min(a + run, columns));
        a += run; c = c ? 0 : 1;
      }
      outRows.push(dst);
    }
  } else {
    // G4 2D
    while (maxRows-- > 0 && st.pos < st.src.length) {
      const dst = new Uint8Array(stride);
      let a = 0, c = 0;
      let line = true;
      while (a < columns) {
        st.fill();
        const code = st.getCode(D2, 7);
        if (code === HORIZ) {
          if (a < 0) a = 0;
          const r1 = st.getRun(c);
          if (c) setBits(dst, a, Math.min(a + r1, columns));
          a += r1; c = c ? 0 : 1;
          const r2 = st.getRun(c);
          if (c) setBits(dst, a, Math.min(a + r2, columns));
          a += r2; c = c ? 0 : 1;
          continue;
        }
        if (code === PASS) {
          const b1 = nextColorEdge(ref, a, columns, c ? 0 : 1);
          const b2 = b1 >= columns ? columns : nextEdge(ref, b1, columns);
          if (c) setBits(dst, a, b2);
          a = b2; continue;
        }
        let offset = 0;
        if (code === V0) offset = 0;
        else if (code === VR1) offset = 1;
        else if (code === VR2) offset = 2;
        else if (code === VR3) offset = 3;
        else if (code === VL1) offset = -1;
        else if (code === VL2) offset = -2;
        else if (code === VL3) offset = -3;
        else { line = false; break; } // EOL/error
        let b1 = nextColorEdge(ref, a, columns, c ? 0 : 1) + offset;
        if (b1 < 0) b1 = 0;
        if (b1 > columns) b1 = columns;
        if (c) setBits(dst, a, b1);
        a = b1; c = c ? 0 : 1;
      }
      outRows.push(dst);
      ref = dst;
      if (!line && st.pos >= st.src.length) break;
    }
  }

  const out = new Uint8Array(outRows.length * stride);
  for (let i = 0; i < outRows.length; i++) out.set(outRows[i]!, i * stride);
  return out;
}
