/**
 * PDF 객체 모델 + 문서 파서.
 *
 * 전략(견고성 우선): 완전한 xref 기계 대신 **선두 스캔**으로 모든 "N G obj … endobj" 를
 * 수집하고, 압축본(PDF 1.5+)이 객체를 숨겨 두는 **객체 스트림(/Type /ObjStm)** 을 풀어
 * 그 안의 객체까지 합친다. 이러면 대부분의 실파일에서 페이지·폰트·콘텐츠를 찾을 수 있다.
 * (손상 xref 에도 강하다. 단점: 무효화된 옛 객체가 새 객체로 덮이지 않을 수 있어, 같은
 *  번호는 "파일에서 나중에 나온 정의"를 채택해 증분 갱신을 근사한다.)
 */
import { flateDecode, lzwDecode, asciiHexDecode, ascii85Decode, applyPredictor } from "./pdfFilters.js";
import { PdfCrypt } from "./pdfCrypt.js";

/** PDF name 객체 (/Foo). 문자열과 구분하기 위한 래퍼. */
export class PName {
  constructor(public name: string) {}
}
/** 간접참조 (N G R). */
export class PRef {
  constructor(public num: number, public gen: number) {}
}
/** 스트림 객체: 딕셔너리 + 원본(raw) 바이트. */
export class PStream {
  constructor(public dict: PDict, public raw: Uint8Array) {}
}
export type PDict = { [key: string]: PdfValue };
export type PdfValue = null | boolean | number | Uint8Array | PName | PRef | PdfValue[] | PDict | PStream;

const latin1 = new TextDecoder("latin1");

function isWs(c: number): boolean {
  return c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x00;
}
function isDelim(c: number): boolean {
  return (
    c === 0x28 || c === 0x29 || c === 0x3c || c === 0x3e || c === 0x5b || c === 0x5d ||
    c === 0x7b || c === 0x7d || c === 0x2f || c === 0x25
  );
}

/** 바이트열의 한 지점부터 PDF 객체 하나를 파싱하는 재귀 하강 파서. */
export class PdfLexer {
  pos: number;
  constructor(public buf: Uint8Array, start = 0) {
    this.pos = start;
  }

  private skipWs(): void {
    while (this.pos < this.buf.length) {
      const c = this.buf[this.pos]!;
      if (c === 0x25) {
        // 주석 % … 줄끝
        while (this.pos < this.buf.length && this.buf[this.pos] !== 0x0a && this.buf[this.pos] !== 0x0d) this.pos++;
      } else if (isWs(c)) this.pos++;
      else break;
    }
  }

  /** 다음 토큰이 키워드 kw 면 소비하고 true. */
  private tryKeyword(kw: string): boolean {
    this.skipWs();
    for (let i = 0; i < kw.length; i++) if (this.buf[this.pos + i] !== kw.charCodeAt(i)) return false;
    const after = this.buf[this.pos + kw.length];
    if (after !== undefined && !isWs(after) && !isDelim(after)) return false;
    this.pos += kw.length;
    return true;
  }

  parseValue(): PdfValue {
    this.skipWs();
    const c = this.buf[this.pos]!;
    if (c === 0x2f) return this.parseName();
    if (c === 0x28) return this.parseLiteralString();
    if (c === 0x3c) {
      if (this.buf[this.pos + 1] === 0x3c) return this.parseDictOrStream();
      return this.parseHexString();
    }
    if (c === 0x5b) return this.parseArray();
    if (this.tryKeyword("true")) return true;
    if (this.tryKeyword("false")) return false;
    if (this.tryKeyword("null")) return null;
    // 숫자 또는 참조(N G R)
    return this.parseNumberOrRef();
  }

  private readToken(): string {
    this.skipWs();
    let s = "";
    while (this.pos < this.buf.length) {
      const c = this.buf[this.pos]!;
      if (isWs(c) || isDelim(c)) break;
      s += String.fromCharCode(c);
      this.pos++;
    }
    return s;
  }

  private parseName(): PName {
    this.pos++; // '/'
    let s = "";
    while (this.pos < this.buf.length) {
      const c = this.buf[this.pos]!;
      if (isWs(c) || isDelim(c)) break;
      if (c === 0x23) {
        // #xx 16진 이스케이프
        const h = parseInt(latin1.decode(this.buf.subarray(this.pos + 1, this.pos + 3)), 16);
        if (!Number.isNaN(h)) {
          s += String.fromCharCode(h);
          this.pos += 3;
          continue;
        }
      }
      s += String.fromCharCode(c);
      this.pos++;
    }
    return new PName(s);
  }

  private parseLiteralString(): Uint8Array {
    this.pos++; // '('
    const out: number[] = [];
    let depth = 1;
    while (this.pos < this.buf.length) {
      const c = this.buf[this.pos++]!;
      if (c === 0x5c) {
        // 백슬래시 이스케이프
        const n = this.buf[this.pos++]!;
        switch (n) {
          case 0x6e: out.push(0x0a); break; // \n
          case 0x72: out.push(0x0d); break; // \r
          case 0x74: out.push(0x09); break; // \t
          case 0x62: out.push(0x08); break; // \b
          case 0x66: out.push(0x0c); break; // \f
          case 0x28: out.push(0x28); break;
          case 0x29: out.push(0x29); break;
          case 0x5c: out.push(0x5c); break;
          case 0x0d: if (this.buf[this.pos] === 0x0a) this.pos++; break; // 줄잇기
          case 0x0a: break;
          default:
            if (n >= 0x30 && n <= 0x37) {
              // 8진 \ddd (최대 3자리)
              let o = n - 0x30;
              for (let k = 0; k < 2; k++) {
                const d = this.buf[this.pos]!;
                if (d >= 0x30 && d <= 0x37) {
                  o = o * 8 + (d - 0x30);
                  this.pos++;
                } else break;
              }
              out.push(o & 0xff);
            } else out.push(n);
        }
      } else if (c === 0x28) {
        depth++;
        out.push(c);
      } else if (c === 0x29) {
        depth--;
        if (depth === 0) break;
        out.push(c);
      } else out.push(c);
    }
    return Uint8Array.from(out);
  }

  private parseHexString(): Uint8Array {
    this.pos++; // '<'
    const out: number[] = [];
    let hi = -1;
    while (this.pos < this.buf.length) {
      const c = this.buf[this.pos++]!;
      if (c === 0x3e) break;
      let v: number;
      if (c >= 0x30 && c <= 0x39) v = c - 0x30;
      else if (c >= 0x41 && c <= 0x46) v = c - 0x41 + 10;
      else if (c >= 0x61 && c <= 0x66) v = c - 0x61 + 10;
      else continue;
      if (hi < 0) hi = v;
      else {
        out.push((hi << 4) | v);
        hi = -1;
      }
    }
    if (hi >= 0) out.push(hi << 4);
    return Uint8Array.from(out);
  }

  private parseArray(): PdfValue[] {
    this.pos++; // '['
    const arr: PdfValue[] = [];
    while (true) {
      this.skipWs();
      if (this.buf[this.pos] === 0x5d) {
        this.pos++;
        break;
      }
      if (this.pos >= this.buf.length) break;
      arr.push(this.parseValue());
    }
    return arr;
  }

  private parseDictOrStream(): PDict | PStream {
    this.pos += 2; // '<<'
    const dict: PDict = {};
    while (true) {
      this.skipWs();
      if (this.buf[this.pos] === 0x3e && this.buf[this.pos + 1] === 0x3e) {
        this.pos += 2;
        break;
      }
      if (this.pos >= this.buf.length) break;
      if (this.buf[this.pos] !== 0x2f) {
        // 깨진 키 — 한 토큰 버리고 진행
        this.readToken();
        continue;
      }
      const key = this.parseName().name;
      dict[key] = this.parseValue();
    }
    // stream 키워드?
    const save = this.pos;
    if (this.tryKeyword("stream")) {
      // stream 다음 CRLF 또는 LF
      if (this.buf[this.pos] === 0x0d) this.pos++;
      if (this.buf[this.pos] === 0x0a) this.pos++;
      const start = this.pos;
      let len = typeof dict.Length === "number" ? dict.Length : -1;
      let end: number;
      if (len >= 0 && start + len <= this.buf.length) {
        end = start + len;
        // Length 가 맞는지 endstream 으로 검증, 어긋나면 스캔으로 폴백
        const probe = this.indexOf("endstream", end - 2);
        if (probe < 0 || probe > end + 32) end = this.scanEndstream(start);
      } else {
        end = this.scanEndstream(start);
      }
      const raw = this.buf.subarray(start, end);
      this.pos = this.indexOf("endstream", end);
      if (this.pos < 0) this.pos = this.buf.length;
      else this.pos += "endstream".length;
      return new PStream(dict, raw);
    }
    this.pos = save;
    return dict;
  }

  private scanEndstream(start: number): number {
    const idx = this.indexOf("endstream", start);
    if (idx < 0) return this.buf.length;
    let end = idx;
    // endstream 앞 줄끝 제거
    if (this.buf[end - 1] === 0x0a) end--;
    if (this.buf[end - 1] === 0x0d) end--;
    return end;
  }

  private indexOf(needle: string, from: number): number {
    const n0 = needle.charCodeAt(0);
    outer: for (let i = Math.max(0, from); i <= this.buf.length - needle.length; i++) {
      if (this.buf[i] !== n0) continue;
      for (let j = 1; j < needle.length; j++) if (this.buf[i + j] !== needle.charCodeAt(j)) continue outer;
      return i;
    }
    return -1;
  }

  private parseNumberOrRef(): number | PRef {
    const t1 = this.readToken();
    const n1 = Number(t1);
    if (!Number.isInteger(n1) || n1 < 0) return Number.isNaN(n1) ? 0 : n1;
    // "N G R" 또는 "N G obj" 일 수 있음 — 미리보기
    const save = this.pos;
    const t2 = this.readToken();
    const n2 = Number(t2);
    if (Number.isInteger(n2) && n2 >= 0) {
      const save2 = this.pos;
      const t3 = this.readToken();
      if (t3 === "R") return new PRef(n1, n2);
      this.pos = save2;
    }
    this.pos = save;
    return n1;
  }
}

/** 파싱된 PDF 문서: 객체 맵 + 참조 해석 + 스트림 디코드. */
export class PdfDocument {
  /** "num gen" → 값. 같은 번호는 파일 뒤쪽 정의가 우선(증분 갱신 근사). */
  private objs = new Map<number, PdfValue>();
  /** 객체번호 → 세대(gen). 복호화 키 유도에 필요. */
  private gens = new Map<number, number>();
  trailer: PDict = {};
  /** 보안 핸들러(RC4). 빈암호 PDF 복호용. */
  private crypt?: PdfCrypt;
  /** AES 등 미지원 암호로 암호화됨 → 텍스트가 안 나옴(호출측 안내용). */
  encryptedUnsupported = false;

  constructor(public buf: Uint8Array) {
    this.scanObjects();
    this.findTrailer();
    this.initCrypt(); // 트레일러 확보 후 복호화(이미지·텍스트가 깨진 바이트가 되지 않게)
    this.loadObjStreams(); // ObjStm raw 는 위에서 복호됨 → 내부 객체는 평문
  }

  /** 선두 스캔: 모든 "N G obj" 정의를 수집. */
  private scanObjects(): void {
    const re = /(\d+)\s+(\d+)\s+obj\b/g;
    const text = latin1.decode(this.buf);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const num = Number(m[1]);
      const gen = Number(m[2]);
      const bodyStart = m.index + m[0].length;
      const lex = new PdfLexer(this.buf, bodyStart);
      try {
        const val = lex.parseValue();
        this.objs.set(num, val); // 뒤쪽 정의가 앞쪽을 덮음 → 증분 갱신 근사
        this.gens.set(num, gen);
      } catch {
        /* 깨진 객체는 건너뜀 */
      }
    }
  }

  /** /Encrypt 가 있으면 보안 핸들러를 세우고 모든 최상위 객체의 문자열/스트림을 복호한다. */
  private initCrypt(): void {
    const encRef = this.trailer.Encrypt;
    if (!encRef) return;
    const enc = this.getDict(encRef ?? null);
    if (!enc) return;
    const str = (v: PdfValue): Uint8Array => (this.resolve(v) instanceof Uint8Array ? (this.resolve(v) as Uint8Array) : new Uint8Array(0));
    // /CF /StdCF /CFM 으로 암호 방식 판별(V>=4). 기본은 RC4.
    let cfm = "V2";
    const cf = this.getDict(this.get(enc, "CF"));
    const stdcf = this.getDict(this.get(cf, "StdCF"));
    const cfmName = this.get(stdcf, "CFM");
    if (cfmName instanceof PName) cfm = cfmName.name;
    const idArr = this.resolve(this.trailer.ID ?? null);
    const id0 = Array.isArray(idArr) && idArr[0] instanceof Uint8Array ? (idArr[0] as Uint8Array) : new Uint8Array(0);
    const emObj = this.get(enc, "EncryptMetadata");
    const crypt = new PdfCrypt({
      V: this.numOf(this.get(enc, "V"), 0),
      R: this.numOf(this.get(enc, "R"), 0),
      lengthBits: this.numOf(this.get(enc, "Length"), 40),
      O: str(this.get(enc, "O")),
      U: str(this.get(enc, "U")),
      P: this.numOf(this.get(enc, "P"), 0),
      id0,
      encryptMetadata: emObj === false ? false : true,
      cfm,
    });
    if (crypt.unsupported) {
      this.encryptedUnsupported = true;
      return;
    }
    if (!crypt.active) return;
    this.crypt = crypt;
    const encObjNum = encRef instanceof PRef ? encRef.num : -1;
    for (const [num, val] of this.objs) {
      if (num === encObjNum) continue; // Encrypt 딕셔너리 자체는 복호 안 함
      this.decryptValue(val, num, this.gens.get(num) ?? 0);
    }
  }

  /** 값 안의 모든 문자열(in-place)·스트림(raw 교체)을 객체키로 복호한다. */
  private decryptValue(v: PdfValue, num: number, gen: number, depth = 0): void {
    if (!this.crypt || depth > 50) return;
    if (v instanceof PStream) {
      v.raw = this.crypt.decrypt(v.raw.slice(), num, gen); // raw 는 buf 의 subarray → 복사본으로 교체
      for (const key of Object.keys(v.dict)) this.decryptValue(v.dict[key]!, num, gen, depth + 1);
    } else if (Array.isArray(v)) {
      for (const el of v) this.decryptValue(el, num, gen, depth + 1);
    } else if (v instanceof Uint8Array) {
      // 문자열은 scan 에서 새로 만든 배열 → in-place 복호 안전
      const dec = this.crypt.decrypt(v, num, gen);
      v.set(dec);
    } else if (v && typeof v === "object" && !(v instanceof PName) && !(v instanceof PRef)) {
      for (const key of Object.keys(v)) this.decryptValue((v as PDict)[key]!, num, gen, depth + 1);
    }
  }

  /** /Type /ObjStm 압축 객체 스트림을 풀어 내부 객체를 맵에 합친다. */
  private loadObjStreams(): void {
    for (const val of [...this.objs.values()]) {
      if (!(val instanceof PStream)) continue;
      const ty = val.dict.Type;
      if (!(ty instanceof PName) || ty.name !== "ObjStm") continue;
      const data = this.decodeStream(val);
      const n = typeof val.dict.N === "number" ? val.dict.N : 0;
      const first = typeof val.dict.First === "number" ? val.dict.First : 0;
      const header = new PdfLexer(data, 0);
      const entries: { num: number; off: number }[] = [];
      for (let i = 0; i < n; i++) {
        const num = header.parseValue();
        const off = header.parseValue();
        if (typeof num === "number" && typeof off === "number") entries.push({ num, off });
      }
      for (const e of entries) {
        // ObjStm 안 객체는 기존(파일 본문)에 없을 때만 채운다(본문 갱신 우선).
        if (this.objs.has(e.num)) continue;
        try {
          const lex = new PdfLexer(data, first + e.off);
          this.objs.set(e.num, lex.parseValue());
        } catch {
          /* skip */
        }
      }
    }
  }

  /** trailer 딕셔너리(또는 xref 스트림 딕셔너리)에서 /Root 등을 찾는다. */
  private findTrailer(): void {
    const text = latin1.decode(this.buf);
    let idx = text.lastIndexOf("trailer");
    while (idx >= 0) {
      const lex = new PdfLexer(this.buf, idx + "trailer".length);
      try {
        const d = lex.parseValue();
        if (d && typeof d === "object" && !(d instanceof PRef) && !Array.isArray(d) && !(d instanceof PStream)) {
          this.trailer = { ...(d as PDict), ...this.trailer };
        }
      } catch {
        /* skip */
      }
      idx = text.lastIndexOf("trailer", idx - 1);
    }
    // xref 스트림 방식: trailer 키워드가 없을 수 있음 → /Root 가진 객체를 찾는다.
    if (!this.trailer.Root) {
      for (const v of this.objs.values()) {
        const d = v instanceof PStream ? v.dict : (v as PDict);
        if (d && typeof d === "object" && (d as PDict).Root) {
          this.trailer.Root = (d as PDict).Root ?? null;
          break;
        }
      }
    }
  }

  /** 참조를 해석해 실제 값을 돌려준다(체인 따라감). */
  resolve(v: PdfValue): PdfValue {
    let cur = v;
    let guard = 0;
    while (cur instanceof PRef && guard++ < 64) cur = this.objs.get(cur.num) ?? null;
    return cur;
  }

  /** 딕셔너리에서 키를 해석해 가져온다. */
  get(dict: PDict | undefined, key: string): PdfValue {
    if (!dict) return null;
    return this.resolve(dict[key] ?? null);
  }

  getDict(v: PdfValue): PDict | undefined {
    const r = this.resolve(v);
    if (r instanceof PStream) return r.dict;
    if (r && typeof r === "object" && !(r instanceof PName) && !(r instanceof PRef) && !Array.isArray(r))
      return r as PDict;
    return undefined;
  }

  /** /Root → /Pages → 페이지 노드들을 트리 순회로 평탄화. */
  getPages(): PDict[] {
    const root = this.getDict(this.trailer.Root ?? null);
    const pagesRoot = this.getDict(this.get(root, "Pages"));
    const out: PDict[] = [];
    const seen = new Set<PdfValue>();
    const walk = (node: PDict | undefined, inherited: PDict): void => {
      if (!node || seen.has(node) || out.length > 5000) return;
      seen.add(node);
      const type = this.get(node, "Type");
      const merged: PDict = { ...inherited };
      for (const k of ["Resources", "MediaBox", "CropBox", "Rotate"])
        if (node[k] !== undefined) merged[k] = node[k];
      const isPages = type instanceof PName && type.name === "Pages";
      const kids = this.resolve(this.get(node, "Kids"));
      if (isPages || Array.isArray(kids)) {
        if (Array.isArray(kids)) for (const kid of kids) walk(this.getDict(kid), merged);
      } else {
        // Page 노드: 상속 속성을 합쳐 보관
        out.push({ ...merged, ...node });
      }
    };
    walk(pagesRoot, {});
    return out;
  }

  /** 스트림 raw → /Filter 체인 적용 후 디코드된 바이트. */
  decodeStream(s: PStream): Uint8Array {
    let data = s.raw;
    const filters = this.asArray(this.get(s.dict, "Filter"));
    const parmsList = this.asArray(this.get(s.dict, "DecodeParms"));
    for (let i = 0; i < filters.length; i++) {
      const f = this.resolve(filters[i]!);
      const name = f instanceof PName ? f.name : "";
      const parms = this.getDict(parmsList[i] ?? null);
      if (name === "FlateDecode" || name === "Fl") {
        data = flateDecode(data);
        data = this.maybePredictor(data, parms);
      } else if (name === "LZWDecode" || name === "LZW") {
        const early = this.numOf(this.get(parms, "EarlyChange"), 1);
        data = lzwDecode(data, early);
        data = this.maybePredictor(data, parms);
      } else if (name === "ASCIIHexDecode" || name === "AHx") {
        data = asciiHexDecode(data);
      } else if (name === "ASCII85Decode" || name === "A85") {
        data = ascii85Decode(data);
      } else {
        // 이미지/미지원 필터 — 텍스트 추출과 무관, 중단
        break;
      }
    }
    return data;
  }

  private maybePredictor(data: Uint8Array, parms: PDict | undefined): Uint8Array {
    if (!parms) return data;
    const pred = this.get(parms, "Predictor");
    if (typeof pred !== "number" || pred < 2) return data;
    const colors = this.numOf(this.get(parms, "Colors"), 1);
    const bpc = this.numOf(this.get(parms, "BitsPerComponent"), 8);
    const columns = this.numOf(this.get(parms, "Columns"), 1);
    return applyPredictor(data, pred, colors, bpc, columns);
  }

  private asArray(v: PdfValue): PdfValue[] {
    const r = this.resolve(v);
    if (r === null || r === undefined) return [];
    return Array.isArray(r) ? r : [r];
  }
  numOf(v: PdfValue, dflt: number): number {
    const r = this.resolve(v);
    return typeof r === "number" ? r : dflt;
  }
}
