/**
 * PDF 콘텐츠 스트림 → 위치보존 텍스트 항목(T2).
 *
 * 텍스트 연산자(BT·ET·Tf·Td·TD·Tm·Tstar·Tj·TJ 등 + Tc·Tw·Tz·TL·Ts)를 해석하고,
 * 텍스트행렬·CTM 을 곱해 각 글자 묶음의 장치좌표(원점)·실효 글꼴크기를 구한다.
 * 글자 매핑은 폰트의 ToUnicode CMap(있으면)으로, 없으면 코드→문자 폴백.
 * 글자 전진은 폰트 폭(/Widths · CID /W)으로 계산해 같은 줄의 다음 묶음이 겹치지 않게 한다.
 *
 * T2 한계(정직히): 회전/전단이 큰 텍스트는 원점·크기만 근사하고 기울이진 않는다.
 * ToUnicode 없는 CID 폰트는 글자를 복원할 수 없어 □ 로 표시한다.
 */
import { PdfDocument, PdfLexer, PName, PStream, type PDict, type PdfValue } from "./pdfObjects.js";
import { embedFontFace } from "./pdfFontEmbed.js";

/** 행렬 [a b c d e f] (PDF 텍스트/그래픽 공통). */
type Mat = [number, number, number, number, number, number];
const IDENT: Mat = [1, 0, 0, 1, 0, 0];

/** A 를 먼저, B 를 나중에 적용 (point' = point·A·B). 결과 = A·B. */
function mul(a: Mat, b: Mat): Mat {
  return [
    a[0] * b[0] + a[1] * b[2],
    a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2],
    a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4],
    a[4] * b[1] + a[5] * b[3] + b[5],
  ];
}

export interface TextItem {
  /** 장치좌표 원점(PDF 단위, x 오른쪽 / y 위쪽 기준). */
  x: number;
  y: number;
  /** 실효 글꼴 크기(PDF 단위, 세로). */
  size: number;
  text: string;
  bold: boolean;
  italic: boolean;
  /** 그리기 순서(이미지·벡터·텍스트 공통 시퀀스) — 층위 보존용. */
  seq: number;
  /** 런의 원본 가로 폭(PDF 단위). 대체폰트가 더 넓게 그려질 때 이 폭으로 압축(scaleX)해 잘림 방지. */
  w?: number;
  /** 임베디드 폰트 @font-face family(있으면). 런 결합은 같은 ff 끼리만. */
  ff?: string;
}
export interface PageText {
  wPt: number;
  hPt: number;
  rotate: number;
  /** MediaBox 원점(좌하단). 보통 0 이지만 비0 일 수 있어 좌표 기준으로 보존. */
  x0: number;
  y0: number;
  items: TextItem[];
  images: ImagePlacement[];
  paths: RenderPath[];
}

/** 폰트 모델: 코드→유니코드 + 코드→폭(글리프공간/1000) + 굵기/기울임. */
interface FontModel {
  twoByte: boolean;
  toUnicode?: Map<number, string>;
  /** 코드 자체가 유니코드(UCS-2)인 인코딩(UniKS-UCS2-H 등) → ToUnicode 없어도 직접 디코드. */
  unicodeCodes: boolean;
  widths: Map<number, number>;
  defaultWidth: number;
  bold: boolean;
  italic: boolean;
  /** 임베디드 폰트 @font-face family(있으면). 없으면 대체폰트로 그린다. */
  embedFamily?: string;
}

const latin1 = new TextDecoder("latin1");

/** ToUnicode CMap 스트림 텍스트 → 코드→문자열 맵 + 코드 바이트수. */
function parseToUnicode(text: string): { map: Map<number, string>; twoByte: boolean } {
  const map = new Map<number, string>();
  let twoByte = false;

  // codespacerange 로 바이트수 추정
  const csr = /begincodespacerange([\s\S]*?)endcodespacerange/.exec(text);
  if (csr) {
    const h = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/.exec(csr[1]!);
    if (h && h[1]!.length >= 4) twoByte = true;
  }

  const hexToStr = (hex: string): string => {
    // UTF-16BE → JS 문자열
    let s = "";
    for (let i = 0; i + 4 <= hex.length; i += 4) s += String.fromCharCode(parseInt(hex.substr(i, 4), 16));
    if (hex.length % 4 === 2) s += String.fromCharCode(parseInt(hex.substr(hex.length - 2, 2), 16));
    return s;
  };

  // bfchar: <src> <dst>
  for (const blk of text.match(/beginbfchar([\s\S]*?)endbfchar/g) ?? []) {
    const re = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(blk))) map.set(parseInt(m[1]!, 16), hexToStr(m[2]!));
  }
  // bfrange: <lo> <hi> <dst>  또는  <lo> <hi> [<d1> <d2> …]
  for (const blk of text.match(/beginbfrange([\s\S]*?)endbfrange/g) ?? []) {
    const re = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(\[[\s\S]*?\]|<[0-9A-Fa-f]+>)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(blk))) {
      const lo = parseInt(m[1]!, 16);
      const hi = parseInt(m[2]!, 16);
      const dst = m[3]!;
      if (dst.startsWith("[")) {
        const items = dst.match(/<([0-9A-Fa-f]+)>/g) ?? [];
        for (let i = 0; lo + i <= hi && i < items.length; i++)
          map.set(lo + i, hexToStr(items[i]!.replace(/[<>]/g, "")));
      } else {
        const base = dst.replace(/[<>]/g, "");
        const baseCode = parseInt(base, 16);
        for (let c = lo; c <= hi && c - lo < 65536; c++) {
          // 마지막 4자리(코드포인트)만 증가
          map.set(c, hexToStr((baseCode + (c - lo)).toString(16).padStart(base.length, "0")));
        }
      }
    }
  }
  return { map, twoByte };
}

/** 폰트 딕셔너리 → FontModel. */
function buildFont(doc: PdfDocument, fontDict: PDict): FontModel {
  const subtype = doc.get(fontDict, "Subtype");
  const isType0 = subtype instanceof PName && subtype.name === "Type0";
  const widths = new Map<number, number>();
  let defaultWidth = isType0 ? 1000 : 500;

  // ToUnicode
  let toUnicode: Map<number, string> | undefined;
  let twoByte = isType0;
  const tu = doc.get(fontDict, "ToUnicode");
  if (tu instanceof PStream) {
    const parsed = parseToUnicode(latin1.decode(doc.decodeStream(tu)));
    toUnicode = parsed.map;
    if (parsed.twoByte) twoByte = true;
  }

  // 인코딩(/Encoding) 분석 — 미리정의 CMap 이름이면 코드 폭·유니코드 여부 판단.
  //   Identity-H/V       : 2바이트, 코드=CID(유니코드 아님)
  //   Uni*-UCS2/UTF16-*  : 2바이트, 코드=유니코드(직접 디코드 가능)  ← UniKS-UCS2-H 등
  let unicodeCodes = false;
  const encName = (() => {
    const e = doc.get(fontDict, "Encoding");
    return e instanceof PName ? e.name : "";
  })();
  if (isType0) {
    if (/Identity-[HV]/.test(encName)) twoByte = true;
    else if (/UCS2|UTF16/i.test(encName)) { twoByte = true; unicodeCodes = true; }
    else if (encName) twoByte = true; // 그밖의 CJK 미리정의 CMap도 2바이트(디코드는 ToUnicode 의존)
  }

  // FontDescriptor(단순=fontDict, Type0=자손폰트). 굵기/기울임 판별에 사용.
  let descriptor: PDict | undefined;
  if (isType0) {
    const descs = doc.get(fontDict, "DescendantFonts");
    const desc = doc.getDict(Array.isArray(descs) ? descs[0] ?? null : descs);
    if (desc) {
      defaultWidth = doc.numOf(doc.get(desc, "DW"), 1000);
      const w = doc.get(desc, "W");
      if (Array.isArray(w)) parseCidWidths(doc, w, widths);
      descriptor = doc.getDict(doc.get(desc, "FontDescriptor"));
    }
  } else {
    // 단순 폰트 /FirstChar + /Widths
    const first = doc.numOf(doc.get(fontDict, "FirstChar"), 0);
    const wArr = doc.get(fontDict, "Widths");
    if (Array.isArray(wArr)) {
      for (let i = 0; i < wArr.length; i++) {
        const wv = doc.resolve(wArr[i]!);
        if (typeof wv === "number") widths.set(first + i, wv);
      }
    }
    descriptor = doc.getDict(doc.get(fontDict, "FontDescriptor"));
  }

  // 굵기/기울임: BaseFont 이름 + FontDescriptor(Flags ForceBold/Italic, FontWeight).
  const baseFont = (() => { const bf = doc.get(fontDict, "BaseFont"); return bf instanceof PName ? bf.name : ""; })();
  let bold = /bold|black|heavy|semibold|extrabold/i.test(baseFont);
  let italic = /italic|oblique/i.test(baseFont);
  if (descriptor) {
    const flags = doc.numOf(doc.get(descriptor, "Flags"), 0);
    if (flags & 0x40000) bold = true; // bit19 ForceBold
    if (flags & 0x40) italic = true; // bit7 Italic
    if (doc.numOf(doc.get(descriptor, "FontWeight"), 0) >= 600) bold = true;
    const dbf = doc.get(descriptor, "FontName");
    if (dbf instanceof PName && /bold|black|heavy/i.test(dbf.name)) bold = true;
  }

  // 임베디드 폰트 임베딩(단순/CID, TrueType/OpenType/CFF). 실패 시 대체폰트로 폴백.
  // 렌더가 내보내는 유니코드(codeToText)와 글리프를 잇도록 동일 매핑정보를 넘긴다.
  const embedFamily = embedFontFace(doc, fontDict, { toUnicode, unicodeCodes, twoByte, widths, defaultWidth }) ?? undefined;

  return { twoByte, toUnicode, unicodeCodes, widths, defaultWidth, bold, italic, embedFamily };
}

/** CID /W 배열 파싱: "c [w…]" 또는 "cFirst cLast w". */
function parseCidWidths(doc: PdfDocument, w: PdfValue[], out: Map<number, number>): void {
  let i = 0;
  while (i < w.length) {
    const a = doc.numOf(w[i++]!, NaN);
    const next = doc.resolve(w[i] ?? null);
    if (Array.isArray(next)) {
      i++;
      for (let k = 0; k < next.length; k++) {
        const wv = doc.resolve(next[k]!);
        if (typeof wv === "number") out.set(a + k, wv);
      }
    } else {
      const b = doc.numOf(w[i++]!, NaN);
      const wv = doc.numOf(w[i++]!, NaN);
      if (Number.isFinite(a) && Number.isFinite(b) && Number.isFinite(wv))
        for (let c = a; c <= b && c - a < 65536; c++) out.set(c, wv);
    }
  }
}

/** 문자열 바이트 → [code…] (폰트 바이트수에 따라). */
function codesOf(bytes: Uint8Array, twoByte: boolean): number[] {
  const codes: number[] = [];
  if (twoByte) for (let i = 0; i + 1 < bytes.length; i += 2) codes.push((bytes[i]! << 8) | bytes[i + 1]!);
  else for (let i = 0; i < bytes.length; i++) codes.push(bytes[i]!);
  return codes;
}

/** 코드 → 표시 문자열(ToUnicode 우선 → UCS2 인코딩이면 코드=유니코드 → 단순폰트 폴백). */
function codeToText(font: FontModel, code: number): string {
  if (font.toUnicode) {
    const s = font.toUnicode.get(code);
    if (s !== undefined) return s;
  }
  // UniKS-UCS2-H 등: 2바이트 코드가 곧 유니코드(ToUnicode 불필요).
  if (font.unicodeCodes) return code > 0 ? String.fromCharCode(code) : "";
  if (font.twoByte) return "�"; // ToUnicode 없는 CID(Identity 등) → 복원 불가
  if (code >= 0x20 && code !== 0x7f) return String.fromCharCode(code); // WinAnsi 근사
  return "";
}

const CONTENT_OPS = new Set([
  "BT", "ET", "Td", "TD", "Tm", "T*", "Tj", "TJ", "'", '"',
  "Tc", "Tw", "Tz", "TL", "Tf", "Ts", "Tr", "q", "Q", "cm",
  "Do", "rg", "g", "k", "sc", "scn", // 비획(채움) 색·XObject
  "RG", "G", "K", "SC", "SCN", "w", // 획(선) 색·선폭
  "m", "l", "c", "v", "y", "re", "h", // 경로 구성
  "S", "s", "f", "F", "f*", "B", "B*", "b", "b*", "n", "W", "W*", // 경로 칠/선/클립
]);

/** 페이지에 배치된 이미지 XObject: 원본 스트림 + 배치 행렬(CTM) + 채움색(ImageMask 용). */
export interface ImagePlacement {
  stream: PStream;
  ctm: number[]; // [a b c d e f]
  fill: [number, number, number];
  seq: number;
}

/** 벡터 경로 명령(장치좌표, PDF y-up). M/L=점1, C=제어2+끝점, Z=닫기. */
export interface PathCmd {
  t: "M" | "L" | "C" | "Z";
  c: number[];
}
/** 칠/선 한 경로(표 테두리·배경칠·밑줄·도형). */
export interface RenderPath {
  cmds: PathCmd[];
  fill?: [number, number, number];
  stroke?: [number, number, number];
  lineWidth: number; // 장치 단위(px 변환 전, PDF point)
  evenOdd: boolean;
  seq: number;
}

/** Form XObject 재귀 한도(폭주/순환 방지). */
const MAX_FORM_DEPTH = 12;
/** 연산자 처리 총량 상한(악성/거대 콘텐츠 방어). */
const MAX_OPS = 8_000_000;
/** 페이지당 글리프 항목 상한(DOM 폭주 방지). */
const MAX_ITEMS = 80_000;
/** 페이지당 벡터 경로 상한(SVG 폭주 방지). */
const MAX_PATHS = 40_000;

/** 한 페이지의 콘텐츠 바이트 + 리소스 → 위치 텍스트 + 이미지 배치. */
export function extractPageText(
  doc: PdfDocument,
  content: Uint8Array,
  resources: PDict | undefined,
  geom: { wPt: number; hPt: number; rotate: number; x0?: number; y0?: number },
): PageText {
  const items: TextItem[] = [];
  const images: ImagePlacement[] = [];
  const paths: RenderPath[] = [];
  let opBudget = MAX_OPS;
  let seq = 0; // 전역 그리기 순서(이미지·벡터·텍스트 공통, 재귀 form 포함)

  // 한 콘텐츠 스트림을 주어진 기준 CTM·리소스로 실행(Form XObject 는 재귀).
  const run = (stream: Uint8Array, res: PDict | undefined, baseCtm: Mat, depth: number): void => {
    const fontCache = new Map<string, FontModel>();
    const fontsDict = doc.getDict(doc.get(res, "Font"));
    const getFont = (name: string): FontModel | undefined => {
      if (fontCache.has(name)) return fontCache.get(name);
      const fd = doc.getDict(doc.get(fontsDict, name));
      if (!fd) return undefined;
      const fm = buildFont(doc, fd);
      fontCache.set(name, fm);
      return fm;
    };

    let ctm: Mat = baseCtm;
    const gsStack: { ctm: Mat; fill: [number, number, number]; stroke: [number, number, number]; lineWidth: number }[] = [];
    let tm: Mat = IDENT;
    let tlm: Mat = IDENT;
    let font: FontModel | undefined;
    let fontSize = 0;
    let charSpace = 0;
    let wordSpace = 0;
    let hScale = 1;
    let leading = 0;
    let rise = 0;
    let renderMode = 0; // Tr: 3·7 = 보이지 않는 텍스트(OCR 숨김층)
    let fill: [number, number, number] = [0, 0, 0];
    let stroke: [number, number, number] = [0, 0, 0];
    let lineWidth = 1;

    // 경로(벡터) 상태 — 점은 USER 공간에서 추적, 명령에 담을 땐 CTM 으로 장치공간 변환.
    let cmds: PathCmd[] = [];
    let cpx = 0, cpy = 0; // 현재점(user)
    let spx = 0, spy = 0; // 서브패스 시작점(user) — h 용
    const tpt = (x: number, y: number): [number, number] => [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]];
    const paint = (doFill: boolean, doStroke: boolean, evenOdd: boolean): void => {
      if (cmds.length && paths.length < MAX_PATHS && (doFill || doStroke)) {
        // 선폭을 장치 단위로 근사(CTM 면적 제곱근).
        const scale = Math.sqrt(Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2])) || 1;
        paths.push({
          cmds,
          fill: doFill ? [...fill] : undefined,
          stroke: doStroke ? [...stroke] : undefined,
          lineWidth: Math.max(lineWidth * scale, 0),
          evenOdd,
          seq: seq++,
        });
      }
      cmds = [];
    };

    const setLine = (m: Mat): void => { tlm = m; tm = m; };

    // 글리프마다 자기 좌표에 개별 배치한다(묶음 단위로 흘리면 폰트 폭 차이로 겹침/표 어긋남).
    const show = (bytes: Uint8Array): void => {
      if (!font) return;
      const invisible = renderMode === 3 || renderMode === 7; // OCR 숨김층 → 위치는 전진하되 안 그림
      const codes = codesOf(bytes, font.twoByte);
      for (const code of codes) {
        const ch = codeToText(font, code);
        // 공백도 보존(런 결합 때 단어 사이 띄어쓰기로 쓰임). 빈 문자열만 건너뜀.
        if (!invisible && ch !== "" && items.length < MAX_ITEMS) {
          const textState: Mat = [fontSize * hScale, 0, 0, fontSize, 0, rise];
          const trm = mul(textState, mul(tm, ctm));
          const size = Math.abs(trm[3]) || Math.abs(fontSize);
          items.push({ x: trm[4], y: trm[5], size, text: ch, bold: font.bold, italic: font.italic, seq: seq++, ff: font.embedFamily });
        }
        const w0 = (font.widths.get(code) ?? font.defaultWidth) / 1000;
        const isSpace = !font.twoByte && code === 0x20;
        const tx = (w0 * fontSize + charSpace + (isSpace ? wordSpace : 0)) * hScale;
        tm = mul([1, 0, 0, 1, tx, 0], tm);
      }
    };

    const showArray = (arr: PdfValue[]): void => {
      if (!font) return;
      for (const el of arr) {
        if (el instanceof Uint8Array) show(el);
        else if (typeof el === "number") {
          const tx = (-el / 1000) * fontSize * hScale;
          tm = mul([1, 0, 0, 1, tx, 0], tm);
        }
      }
    };

    // XObject 배치: 이미지면 기록, Form 이면 재귀.
    const doXObject = (name: string): void => {
      const xobjs = doc.getDict(doc.get(res, "XObject"));
      const xo = doc.resolve(doc.get(xobjs, name));
      if (!(xo instanceof PStream)) return;
      const sub = doc.get(xo.dict, "Subtype");
      const subName = sub instanceof PName ? sub.name : "";
      if (subName === "Image") {
        images.push({ stream: xo, ctm: ctm.slice(), fill, seq: seq++ });
      } else if (subName === "Form" && depth < MAX_FORM_DEPTH) {
        const mtxArr = doc.resolve(doc.get(xo.dict, "Matrix"));
        let fm: Mat = IDENT;
        if (Array.isArray(mtxArr) && mtxArr.length === 6)
          fm = mtxArr.map((v) => doc.numOf(v, 0)) as unknown as Mat;
        const formRes = doc.getDict(doc.get(xo.dict, "Resources")) ?? res;
        run(doc.decodeStream(xo), formRes, mul(fm, ctm), depth + 1);
      }
    };

    const lex = new ContentLexer(stream, 0);
    let stack: PdfValue[] = [];
    while (lex.pos < stream.length && opBudget-- > 0) {
      const tok = lex.nextOperandOrOp();
      if (tok === null) break;
      // op 이 빈문자열("")이어도 연산자다(미등록 cs/CS/gs/BDC… → 스택 비움). value 가 있으면 피연산자.
      if (tok.op !== undefined) {
        const op = tok.op;
        const a = stack;
        const num = (i: number): number => (typeof a[i] === "number" ? (a[i] as number) : 0);
        switch (op) {
          case "q": gsStack.push({ ctm, fill: [...fill], stroke: [...stroke], lineWidth }); break;
          case "Q": { const s = gsStack.pop(); if (s) { ctm = s.ctm; fill = s.fill; stroke = s.stroke; lineWidth = s.lineWidth; } break; }
          case "cm": ctm = mul([num(0), num(1), num(2), num(3), num(4), num(5)], ctm); break;
          case "BT": setLine(IDENT); break;
          case "ET": break;
          case "Tc": charSpace = num(0); break;
          case "Tw": wordSpace = num(0); break;
          case "Tz": hScale = num(0) / 100; break;
          case "TL": leading = num(0); break;
          case "Ts": rise = num(0); break;
          case "Tr": renderMode = num(0); break;
          case "Tf":
            font = a[0] instanceof PName ? getFont((a[0] as PName).name) : undefined;
            fontSize = num(1);
            break;
          case "Td": setLine(mul([1, 0, 0, 1, num(0), num(1)], tlm)); break;
          case "TD": leading = -num(1); setLine(mul([1, 0, 0, 1, num(0), num(1)], tlm)); break;
          case "Tm": setLine([num(0), num(1), num(2), num(3), num(4), num(5)]); break;
          case "T*": setLine(mul([1, 0, 0, 1, 0, -leading], tlm)); break;
          case "Tj": if (a[0] instanceof Uint8Array) show(a[0] as Uint8Array); break;
          case "TJ": if (Array.isArray(a[0])) showArray(a[0] as PdfValue[]); break;
          case "'":
            setLine(mul([1, 0, 0, 1, 0, -leading], tlm));
            if (a[0] instanceof Uint8Array) show(a[0] as Uint8Array);
            break;
          case '"':
            wordSpace = num(0); charSpace = num(1);
            setLine(mul([1, 0, 0, 1, 0, -leading], tlm));
            if (a[2] instanceof Uint8Array) show(a[2] as Uint8Array);
            break;
          // 비획(채움) 색 — ImageMask 색으로 사용
          case "rg": fill = [clampByte(num(0)), clampByte(num(1)), clampByte(num(2))]; break;
          case "g": { const v = clampByte(num(0)); fill = [v, v, v]; break; }
          case "k": fill = cmyk(num(0), num(1), num(2), num(3)); break;
          case "sc": case "scn":
            if (a.length >= 3) fill = [clampByte(num(0)), clampByte(num(1)), clampByte(num(2))];
            else if (a.length === 1) { const v = clampByte(num(0)); fill = [v, v, v]; }
            break;
          // 획(선) 색 + 선폭
          case "RG": stroke = [clampByte(num(0)), clampByte(num(1)), clampByte(num(2))]; break;
          case "G": { const v = clampByte(num(0)); stroke = [v, v, v]; break; }
          case "K": stroke = cmyk(num(0), num(1), num(2), num(3)); break;
          case "SC": case "SCN":
            if (a.length >= 3) stroke = [clampByte(num(0)), clampByte(num(1)), clampByte(num(2))];
            else if (a.length === 1) { const v = clampByte(num(0)); stroke = [v, v, v]; }
            break;
          case "w": lineWidth = num(0); break;
          // ── 경로 구성(USER 좌표 → tpt 로 장치좌표 변환) ──
          case "m": cpx = num(0); cpy = num(1); spx = cpx; spy = cpy; cmds.push({ t: "M", c: tpt(cpx, cpy) }); break;
          case "l": cpx = num(0); cpy = num(1); cmds.push({ t: "L", c: tpt(cpx, cpy) }); break;
          case "c": {
            const p1 = tpt(num(0), num(1)), p2 = tpt(num(2), num(3)), p3 = tpt(num(4), num(5));
            cmds.push({ t: "C", c: [...p1, ...p2, ...p3] }); cpx = num(4); cpy = num(5); break;
          }
          case "v": {
            const p1 = tpt(cpx, cpy), p2 = tpt(num(0), num(1)), p3 = tpt(num(2), num(3));
            cmds.push({ t: "C", c: [...p1, ...p2, ...p3] }); cpx = num(2); cpy = num(3); break;
          }
          case "y": {
            const p1 = tpt(num(0), num(1)), p3 = tpt(num(2), num(3));
            cmds.push({ t: "C", c: [...p1, ...p3, ...p3] }); cpx = num(2); cpy = num(3); break;
          }
          case "re": {
            const x = num(0), y = num(1), w = num(2), h = num(3);
            cmds.push({ t: "M", c: tpt(x, y) }, { t: "L", c: tpt(x + w, y) }, { t: "L", c: tpt(x + w, y + h) }, { t: "L", c: tpt(x, y + h) }, { t: "Z", c: [] });
            cpx = x; cpy = y; spx = x; spy = y; break;
          }
          case "h": cmds.push({ t: "Z", c: [] }); cpx = spx; cpy = spy; break;
          // ── 경로 칠/선 ──
          case "S": paint(false, true, false); break;
          case "s": cmds.push({ t: "Z", c: [] }); paint(false, true, false); break;
          case "f": case "F": paint(true, false, false); break;
          case "f*": paint(true, false, true); break;
          case "B": case "b": if (op === "b") cmds.push({ t: "Z", c: [] }); paint(true, true, false); break;
          case "B*": case "b*": if (op === "b*") cmds.push({ t: "Z", c: [] }); paint(true, true, true); break;
          case "n": cmds = []; break; // 칠 없음(클립 종료) → 경로 폐기
          case "W": case "W*": break; // 클립 영역 설정 — 무시(다음 페인트 op 가 경로 처리)
          case "Do": if (a[0] instanceof PName) doXObject((a[0] as PName).name); break;
        }
        stack = [];
      } else {
        stack.push(tok.value!);
        if (stack.length > 64) stack.shift();
      }
    }
  };

  run(content, resources, IDENT, 0);
  return { wPt: geom.wPt, hPt: geom.hPt, rotate: geom.rotate, x0: geom.x0 ?? 0, y0: geom.y0 ?? 0, items: coalesceRuns(items), images, paths };
}

/**
 * 글리프들을 텍스트 런으로 결합. 같은 줄·같은 서식이고 x 간격이 정상이면 한 런으로 묶어
 * 폰트가 자연스럽게 흐르게 한다(글자별 절대배치 시 대체폰트 폭 불일치로 겹치는 문제 해결).
 * 큰 간격(열 경계)·줄바꿈·서식변화에서 런을 끊어 표/단 정렬은 보존한다.
 */
function coalesceRuns(items: TextItem[]): TextItem[] {
  const out: TextItem[] = [];
  let cur: TextItem | null = null;
  let curEnd = 0; // 현재 런의 추정 오른쪽 끝(x)
  const estW = (it: TextItem): number => {
    const cp = it.text.codePointAt(0) ?? 0;
    return it.size * (cp > 0x2e80 ? 1.0 : 0.5); // CJK 는 전각, 그 외 반각 근사
  };
  for (const it of items) {
    const merge =
      cur !== null &&
      Math.abs(it.y - cur.y) < cur.size * 0.45 && // 같은 줄
      it.size > cur.size * 0.8 && it.size < cur.size * 1.25 && // 같은 크기
      it.bold === cur.bold && it.italic === cur.italic && // 같은 굵기/기울임
      it.ff === cur.ff && // 같은 폰트(임베디드 family)
      it.x >= curEnd - cur.size * 0.5 && // 역방향 큰 점프 아님
      it.x <= curEnd + cur.size * 1.3; // 열 경계만큼 멀지 않음
    if (merge && cur) {
      cur.text += it.text;
      curEnd = it.x + estW(it);
      cur.w = curEnd - cur.x; // 런이 늘어날 때마다 원본 오른쪽 끝까지의 폭 갱신
    } else {
      cur = { ...it };
      out.push(cur);
      curEnd = it.x + estW(it);
      cur.w = curEnd - cur.x;
    }
  }
  // 순수 공백 런은 버린다(시각적 의미 없음).
  return out.filter((r) => r.text.trim() !== "");
}

const clampByte = (v: number): number => Math.max(0, Math.min(255, Math.round(v * 255)));
function cmyk(c: number, m: number, y: number, k: number): [number, number, number] {
  return [
    Math.round(255 * (1 - Math.min(1, c)) * (1 - Math.min(1, k))),
    Math.round(255 * (1 - Math.min(1, m)) * (1 - Math.min(1, k))),
    Math.round(255 * (1 - Math.min(1, y)) * (1 - Math.min(1, k))),
  ];
}

// 콘텐츠용 경량 토크나이저 — pdfObjects 의 PdfLexer 를 확장(피연산자 + bare 연산자).
class ContentLexer extends PdfLexer {
  /** 다음 토큰: 피연산자 값이면 {value}, bare 키워드(연산자)면 {op}. 끝이면 null. */
  nextOperandOrOp(): { value?: PdfValue; op?: string } | null {
    this.skipWsPublic();
    if (this.pos >= this.buf.length) return null;
    const c = this.buf[this.pos]!;
    // 값으로 시작하는 문자들
    if (
      c === 0x2f || c === 0x28 || c === 0x5b || // / ( [
      (c === 0x3c) || // < (hex 또는 dict)
      c === 0x2b || c === 0x2d || c === 0x2e || (c >= 0x30 && c <= 0x39) // 부호/숫자
    ) {
      try {
        return { value: this.parseValue() };
      } catch {
        this.pos++;
        return { op: "" };
      }
    }
    // bare 키워드(연산자 또는 true/false/null)
    let s = "";
    while (this.pos < this.buf.length) {
      const ch = this.buf[this.pos]!;
      if (ch <= 0x20 || ch === 0x2f || ch === 0x5b || ch === 0x28 || ch === 0x3c || ch === 0x5d || ch === 0x3e) break;
      s += String.fromCharCode(ch);
      this.pos++;
    }
    if (s === "") {
      this.pos++;
      return { op: "" };
    }
    if (s === "true") return { value: true };
    if (s === "false") return { value: false };
    if (s === "null") return { value: null };
    if (s === "BI") {
      // 인라인 이미지: ID … EI 까지 통째로 건너뜀(텍스트 없음)
      this.skipInlineImage();
      return { op: "" };
    }
    return { op: CONTENT_OPS.has(s) ? s : "" };
  }

  private skipInlineImage(): void {
    // "EI" 를 공백 경계로 찾는다.
    while (this.pos < this.buf.length - 1) {
      if (
        this.buf[this.pos] === 0x45 && this.buf[this.pos + 1] === 0x49 &&
        (this.pos + 2 >= this.buf.length || this.buf[this.pos + 2]! <= 0x20)
      ) {
        this.pos += 2;
        return;
      }
      this.pos++;
    }
  }

  skipWsPublic(): void {
    while (this.pos < this.buf.length) {
      const c = this.buf[this.pos]!;
      if (c === 0x25) {
        while (this.pos < this.buf.length && this.buf[this.pos] !== 0x0a && this.buf[this.pos] !== 0x0d) this.pos++;
      } else if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x00) this.pos++;
      else break;
    }
  }
}
