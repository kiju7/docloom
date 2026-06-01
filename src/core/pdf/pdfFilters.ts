/**
 * PDF 스트림 필터 디코더.
 *
 * PDF 스트림은 /Filter 로 압축·인코딩된다. 위치보존 텍스트 추출에 필요한 만큼만 구현:
 *   - FlateDecode  : zlib(deflate) — fflate 로 해제(바이트 코덱일 뿐).
 *   - ASCIIHexDecode / ASCII85Decode : 텍스트 인코딩.
 *   - PNG/TIFF 예측기(Predictor) : 일부 FlateDecode 스트림(ObjStm·xref)에 붙는다.
 * (이미지 전용 필터 DCT/CCITT/JBIG2 등은 텍스트 추출과 무관하므로 건너뛴다.)
 */
import { unzlibSync, inflateSync } from "fflate";

/** zlib 헤더(CMF/FLG) 모양인가: 압축법 8(deflate) + 체크 % 31 === 0. */
function looksZlib(data: Uint8Array): boolean {
  return data.length > 2 && (data[0]! & 0x0f) === 8 && (((data[0]! << 8) | data[1]!) % 31) === 0;
}

/**
 * zlib(권장) → 실패 시 raw deflate 로 재시도. PDF FlateDecode 는 보통 zlib 래핑이다.
 *
 * 잘린 스트림(/Length 가 짧거나 트레일러 누락) 주의: unzlibSync 는 Adler 검증에서 "unexpected
 * EOF" 로 던지지만 deflate 페이로드 자체는 멀쩡한 경우가 많다. 이때 헤더 포함 전체를 raw inflate
 * 로 돌리면 zlib 헤더(예: 78 DA)를 deflate 블록으로 오독해 **검증 없이 쓰레기를 뱉고도 성공**한다.
 * 그래서 zlib 헤더가 보이면 raw 폴백은 반드시 앞 2바이트를 건너뛴 페이로드로 한다(트레일러 검증 생략).
 */
export function flateDecode(data: Uint8Array): Uint8Array {
  try {
    return unzlibSync(data);
  } catch {
    const wrapped = looksZlib(data);
    try {
      return inflateSync(wrapped ? data.subarray(2) : data);
    } catch {
      // 반대 해석으로 마지막 시도(헤더 판정이 틀렸을 가능성).
      try {
        return inflateSync(wrapped ? data : data.subarray(2));
      } catch {
        return new Uint8Array(0);
      }
    }
  }
}

/** LZWDecode(가변 9~12bit, 코드 256=clear/257=EOD). PDF 기본 earlyChange=1. */
export function lzwDecode(src: Uint8Array, earlyChange = 1): Uint8Array {
  if (src.length === 0) return new Uint8Array(0);
  const out: number[] = [];
  let table: number[][] = [];
  const reset = (): void => {
    table = [];
    for (let i = 0; i < 256; i++) table.push([i]);
    table.push([]); // 256 clear
    table.push([]); // 257 eod
  };
  reset();
  let bits = 9;
  let bitPos = 0;
  const totalBits = src.length * 8;
  const readCode = (): number => {
    if (bitPos + bits > totalBits) return -1;
    let code = 0;
    for (let b = 0; b < bits; b++) {
      const byteIdx = (bitPos + b) >> 3;
      const bitIdx = 7 - ((bitPos + b) & 7);
      if (src[byteIdx]! & (1 << bitIdx)) code |= 1 << (bits - 1 - b);
    }
    bitPos += bits;
    return code;
  };
  let prev = -1;
  let guard = 0;
  while (guard++ < 50_000_000) {
    const code = readCode();
    if (code < 0 || code === 257) break;
    if (code === 256) { reset(); bits = 9; prev = -1; continue; }
    if (code < table.length && table[code]!.length > 0) {
      for (const b of table[code]!) out.push(b);
      if (prev >= 0 && prev < table.length && table[prev]!.length > 0)
        table.push([...table[prev]!, table[code]![0]!]);
    } else if (prev >= 0 && prev < table.length) {
      const e = [...table[prev]!, table[prev]![0]!];
      for (const b of e) out.push(b);
      table.push(e);
    }
    prev = code;
    const sz = table.length + (earlyChange ? 0 : 1);
    if (sz >= 1 << bits && bits < 12) bits++;
  }
  return Uint8Array.from(out);
}

export function asciiHexDecode(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let hi = -1;
  for (let i = 0; i < data.length; i++) {
    const c = data[i]!;
    if (c === 0x3e) break; // '>' 종료
    let v: number;
    if (c >= 0x30 && c <= 0x39) v = c - 0x30;
    else if (c >= 0x41 && c <= 0x46) v = c - 0x41 + 10;
    else if (c >= 0x61 && c <= 0x66) v = c - 0x61 + 10;
    else continue; // 공백 등 무시
    if (hi < 0) hi = v;
    else {
      out.push((hi << 4) | v);
      hi = -1;
    }
  }
  if (hi >= 0) out.push(hi << 4); // 홀수 자리 → 0 보충
  return Uint8Array.from(out);
}

export function ascii85Decode(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  const tuple: number[] = [];
  let i = 0;
  // 선택적 시작 마커 "<~"
  if (data[0] === 0x3c && data[1] === 0x7e) i = 2;
  for (; i < data.length; i++) {
    const c = data[i]!;
    if (c === 0x7e) break; // '~' 종료
    if (c <= 0x20) continue; // 공백
    if (c === 0x7a && tuple.length === 0) {
      out.push(0, 0, 0, 0); // 'z' = 0 0 0 0
      continue;
    }
    tuple.push(c - 0x21);
    if (tuple.length === 5) {
      let n = 0;
      for (const t of tuple) n = n * 85 + t;
      out.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
      tuple.length = 0;
    }
  }
  if (tuple.length > 0) {
    const cnt = tuple.length;
    while (tuple.length < 5) tuple.push(84);
    let n = 0;
    for (const t of tuple) n = n * 85 + t;
    const bytes = [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
    for (let k = 0; k < cnt - 1; k++) out.push(bytes[k]!);
  }
  return Uint8Array.from(out);
}

/**
 * PNG/TIFF 예측기 역적용. FlateDecode 후 /DecodeParms 에 /Predictor 가 있으면 호출.
 * Predictor 2 = TIFF, 10~15 = PNG(행마다 필터 바이트가 앞에 붙음).
 */
export function applyPredictor(
  data: Uint8Array,
  predictor: number,
  colors: number,
  bpc: number,
  columns: number,
): Uint8Array {
  if (predictor < 2) return data;
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rowLen = Math.ceil((colors * bpc * columns) / 8);
  if (predictor === 2) {
    // TIFF: 같은 행 왼쪽 픽셀과의 차분(bpc=8 가정)
    const out = data.slice();
    for (let r = 0; r + rowLen <= out.length; r += rowLen)
      for (let i = bpp; i < rowLen; i++) out[r + i] = (out[r + i]! + out[r + i - bpp]!) & 0xff;
    return out;
  }
  // PNG 계열: 행 = [filterType][rowLen bytes]
  const stride = rowLen + 1;
  const rows = Math.floor(data.length / stride);
  const out = new Uint8Array(rows * rowLen);
  let prev = new Uint8Array(rowLen);
  for (let r = 0; r < rows; r++) {
    const ft = data[r * stride]!;
    const cur = data.subarray(r * stride + 1, r * stride + 1 + rowLen);
    const dec = out.subarray(r * rowLen, r * rowLen + rowLen);
    for (let i = 0; i < rowLen; i++) {
      const a = i >= bpp ? dec[i - bpp]! : 0;
      const b = prev[i]!;
      const c = i >= bpp ? prev[i - bpp]! : 0;
      let v = cur[i]!;
      switch (ft) {
        case 0: break;
        case 1: v = (v + a) & 0xff; break;
        case 2: v = (v + b) & 0xff; break;
        case 3: v = (v + ((a + b) >> 1)) & 0xff; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
          break;
        }
      }
      dec[i] = v;
    }
    prev = dec;
  }
  return out;
}
