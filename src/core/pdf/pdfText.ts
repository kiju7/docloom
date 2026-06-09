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
import { cidToUnicodeKorea1 } from "./cidUnicodeKorea1.js";
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
  /** 이 글리프의 장치공간 가로 전진폭(PDF 단위). 런 결합 때 위치상(문자 없는) 공백 판정에 사용. */
  adv?: number;
  /** 임베디드 폰트 @font-face family(있으면). 런 결합은 같은 ff 끼리만. */
  ff?: string;
  /** 글자 채움색(RGB 0..255). 기본 검정([0,0,0])이면 생략 가능. 런 결합은 같은 색끼리만. */
  color?: [number, number, number];
  /** 글자 불투명도(0..1, ExtGState ca). 생략=1. */
  alpha?: number;
  /** 회전/전단 텍스트의 단위 선형부 [a,b,c,d](크기 size 로 정규화, CSS y-down 기준).
   *  생략=수평(직립). 있으면 렌더가 CSS matrix 로 기울이고 data-w 압축은 건너뛴다. */
  rot?: [number, number, number, number];
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
  /** Type0+Identity-H 이고 ToUnicode 가 없을 때, 자손폰트 CIDSystemInfo /Ordering.
   *  "Korea1" 이면 표준 Adobe-Korea1 CID 가정하에 코드(=CID)→유니코드 복원. */
  cidOrdering?: string;
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
  let cidOrdering: string | undefined;
  if (isType0) {
    const descs = doc.get(fontDict, "DescendantFonts");
    const desc = doc.getDict(Array.isArray(descs) ? descs[0] ?? null : descs);
    if (desc) {
      defaultWidth = doc.numOf(doc.get(desc, "DW"), 1000);
      const w = doc.get(desc, "W");
      if (Array.isArray(w)) parseCidWidths(doc, w, widths);
      descriptor = doc.getDict(doc.get(desc, "FontDescriptor"));
      // ToUnicode 가 없고 Identity-H 인 CID 폰트만: CIDSystemInfo /Ordering 으로
      // 표준 컬렉션 CID→유니코드 복원을 켠다(현재 Korea1 지원).
      if (!toUnicode && /Identity-[HV]/.test(encName)) {
        const csi = doc.getDict(doc.get(desc, "CIDSystemInfo"));
        if (csi) {
          const str = (v: unknown): string =>
            typeof v === "string" ? v : v instanceof PName ? v.name : v instanceof Uint8Array ? latin1.decode(v) : "";
          const ordName = str(doc.resolve(doc.get(csi, "Ordering")));
          const regName = str(doc.resolve(doc.get(csi, "Registry")));
          // 표준 Adobe-Korea1 컬렉션만(Registry=Adobe). 비표준 생성기가 Ordering 이름만
          // 재사용한 경우의 오매핑을 막는다.
          if (/Korea1/i.test(ordName) && /Adobe/i.test(regName)) cidOrdering = "Korea1";
        }
      }
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
  const embedFamily = embedFontFace(doc, fontDict, { toUnicode, unicodeCodes, twoByte, widths, defaultWidth, cidOrdering }) ?? undefined;

  return { twoByte, toUnicode, unicodeCodes, widths, defaultWidth, bold, italic, embedFamily, cidOrdering };
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

// Wingdings/Symbol 등 심볼폰트의 사유영역(PUA, U+F0xx) 글머리표 → 유니코드 글리프.
// 임베디드 서브셋이 PUA 를 못 그려 ☐(tofu)로 나오므로, 대체폰트가 그릴 수 있는 실제 글자로 치환.
const SYMBOL_PUA: Record<number, string> = {
  0xf0b7: "•", 0xf0a7: "▪", 0xf06e: "■", 0xf06c: "●", 0xf071: "◆", 0xf075: "◆",
  0xf0a8: "▪", 0xf0d8: "➢", 0xf0fc: "✔", 0xf0fb: "✘", 0xf0ad: "□", 0xf09f: "•",
};
/** 디코드 결과의 단일 PUA 심볼문자를 알려진 유니코드로 치환(아니면 그대로). */
function remapSymbol(s: string): string {
  if (s.length === 1) {
    const cp = s.codePointAt(0)!;
    if (cp >= 0xf000 && cp <= 0xf0ff && SYMBOL_PUA[cp]) return SYMBOL_PUA[cp]!;
  }
  return s;
}

/** 코드 → 표시 문자열(ToUnicode 우선 → UCS2 인코딩이면 코드=유니코드 → 단순폰트 폴백). */
function codeToText(font: FontModel, code: number): string {
  if (font.toUnicode) {
    const s = font.toUnicode.get(code);
    if (s !== undefined) return remapSymbol(s);
  }
  // UniKS-UCS2-H 등: 2바이트 코드가 곧 유니코드(ToUnicode 불필요).
  if (font.unicodeCodes) return code > 0 ? String.fromCharCode(code) : "";
  // ToUnicode 없는 Identity-H CID 폰트라도 표준 Adobe-Korea1 컬렉션이면 코드(=CID)→유니코드 복원.
  if (font.cidOrdering === "Korea1") {
    const u = cidToUnicodeKorea1(code);
    if (u !== undefined) return u > 0 ? remapSymbol(String.fromCodePoint(u)) : "";
  }
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
  "gs", "d", "J", "j", // 그래픽상태(투명도 등)·파선·선끝·선이음
]);

/** 페이지에 배치된 이미지 XObject: 원본 스트림 + 배치 행렬(CTM) + 채움색(ImageMask 용). */
/** 클립 사각형(장치좌표, PDF y-up): [x0, y0, x1, y1]. 슬라이드 밖으로 넘치는 표·이미지를 잘라낸다. */
export type ClipRect = [number, number, number, number];

export interface ImagePlacement {
  stream: PStream;
  ctm: number[]; // [a b c d e f]
  fill: [number, number, number];
  seq: number;
  clip?: ClipRect; // 그릴 때 활성 클립(W) — 원본보다 큰 이미지가 칸 밖으로 새는 것 방지
  alpha?: number; // 이미지 불투명도(0..1, ExtGState ca). 생략=1
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
  /** 칠/선 불투명도(0..1). ExtGState ca/CA 에서. 생략=1(불투명). */
  fillAlpha?: number;
  strokeAlpha?: number;
  /** 파선 패턴(장치단위 길이 배열)+위상. 빈/생략=실선. */
  dash?: number[];
  dashPhase?: number;
  /** 선끝 0=butt 1=round 2=square, 선이음 0=miter 1=round 2=bevel. */
  cap?: number;
  join?: number;
  /** 그릴 때 활성 클립(장치좌표). 칸 밖으로 새는 칠을 잘라낸다. */
  clip?: ClipRect;
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
  /** 주석 외관(/AP /N) Form XObject 들 — 페이지 콘텐츠 뒤(위층)에 그 ctm 으로 그린다. */
  annots?: { stream: PStream; ctm: number[]; resources?: PDict }[],
): PageText {
  const items: TextItem[] = [];
  const images: ImagePlacement[] = [];
  const paths: RenderPath[] = [];
  let opBudget = MAX_OPS;
  let seq = 0; // 전역 그리기 순서(이미지·벡터·텍스트 공통, 재귀 form 포함)

  // 한 콘텐츠 스트림을 주어진 기준 CTM·리소스로 실행(Form XObject 는 재귀).
  const run = (stream: Uint8Array, res: PDict | undefined, baseCtm: Mat, depth: number, baseClip?: ClipRect): void => {
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
    let clip: ClipRect | undefined = baseClip; // 현재 클립 사각형(장치좌표). undefined = 페이지 전체. Form 은 바깥 클립 상속.
    let pendingClip: ClipRect | undefined; // W 로 지정됐고 다음 페인트 op 에서 활성화될 클립.
    // 텍스트상태(Tr·자간·글꼴 등)도 PDF 명세상 그래픽상태라 q/Q 로 저장·복원해야 한다
    // (안 하면 q 3 Tr (OCR) Tj Q 뒤에도 Tr 3 이 눌러붙어 진짜 텍스트가 숨거나 OCR 이 샌다).
    type GS = {
      ctm: Mat; fill: [number, number, number]; stroke: [number, number, number]; lineWidth: number; clip?: ClipRect;
      fillAlpha: number; strokeAlpha: number; dash: number[]; dashPhase: number; cap: number; join: number;
      charSpace: number; wordSpace: number; hScale: number; leading: number; rise: number; renderMode: number; font: FontModel | undefined; fontSize: number;
    };
    const gsStack: GS[] = [];
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
    let fillAlpha = 1; // ExtGState ca (채움 불투명도)
    let strokeAlpha = 1; // ExtGState CA (선 불투명도)
    let dash: number[] = []; // 파선 패턴(user 단위) — 비면 실선
    let dashPhase = 0;
    let cap = 0; // 선끝
    let join = 0; // 선이음

    // 경로(벡터) 상태 — 점은 USER 공간에서 추적, 명령에 담을 땐 CTM 으로 장치공간 변환.
    let cmds: PathCmd[] = [];
    let cpx = 0, cpy = 0; // 현재점(user)
    let spx = 0, spy = 0; // 서브패스 시작점(user) — h 용
    const tpt = (x: number, y: number): [number, number] => [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]];
    // 경로 페인트(또는 n) 시점에 W 로 예약된 클립을 활성화한다(PDF: 클립은 페인트 op 뒤 적용).
    const flushClip = (): void => { if (pendingClip) { clip = clipIntersect(clip, pendingClip); pendingClip = undefined; } };
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
          fillAlpha: doFill && fillAlpha < 1 ? fillAlpha : undefined,
          strokeAlpha: doStroke && strokeAlpha < 1 ? strokeAlpha : undefined,
          dash: dash.length ? dash.map((v) => v * scale) : undefined, // 장치단위로 환산
          dashPhase: dash.length ? dashPhase * scale : undefined,
          cap: cap || undefined,
          join: join || undefined,
          clip,
        });
      }
      cmds = [];
      flushClip();
    };

    const setLine = (m: Mat): void => { tlm = m; tm = m; };

    // ExtGState(/gs) — 투명도(ca/CA)·선폭(LW)·파선(D) 등 그래픽상태 묶음 적용.
    const applyGs = (name: string): void => {
      const egDict = doc.getDict(doc.get(res, "ExtGState"));
      const gsd = doc.getDict(doc.get(egDict, name));
      if (!gsd) return;
      const ca = doc.get(gsd, "ca");
      if (typeof ca === "number") fillAlpha = Math.max(0, Math.min(1, ca));
      const CA = doc.get(gsd, "CA");
      if (typeof CA === "number") strokeAlpha = Math.max(0, Math.min(1, CA));
      const lw = doc.get(gsd, "LW");
      if (typeof lw === "number") lineWidth = lw;
      const lc = doc.get(gsd, "LC");
      if (typeof lc === "number") cap = lc;
      const lj = doc.get(gsd, "LJ");
      if (typeof lj === "number") join = lj;
      const D = doc.resolve(doc.get(gsd, "D")); // [ [dashArray] phase ]
      if (Array.isArray(D) && D.length === 2) {
        const arr = doc.resolve(D[0]!);
        if (Array.isArray(arr)) { dash = arr.map((v) => doc.numOf(v, 0)).filter((v) => v >= 0); dashPhase = doc.numOf(D[1]!, 0); }
      }
    };

    // 글리프마다 자기 좌표에 개별 배치한다(묶음 단위로 흘리면 폰트 폭 차이로 겹침/표 어긋남).
    const show = (bytes: Uint8Array): void => {
      if (!font) return;
      const invisible = renderMode === 3 || renderMode === 7; // OCR 숨김층 → 위치는 전진하되 안 그림
      const codes = codesOf(bytes, font.twoByte);
      for (const code of codes) {
        const ch = codeToText(font, code);
        // 이 글리프의 다음 tm(전진폭 측정용) — 폭+자간+(공백이면)단어간격을 미리 계산.
        const w0 = (font.widths.get(code) ?? font.defaultWidth) / 1000;
        const isSpace = !font.twoByte && code === 0x20;
        const tx = (w0 * fontSize + charSpace + (isSpace ? wordSpace : 0)) * hScale;
        const ntm = mul([1, 0, 0, 1, tx, 0], tm);
        // 공백도 보존(런 결합 때 단어 사이 띄어쓰기로 쓰임). 빈 문자열만 건너뜀.
        if (!invisible && ch !== "" && items.length < MAX_ITEMS) {
          const textState: Mat = [fontSize * hScale, 0, 0, fontSize, 0, rise];
          const trm = mul(textState, mul(tm, ctm));
          // 세로 크기는 y축 이미지 길이(회전해도 안정). 직립이면 |trm[3]| 와 같다.
          const size = Math.hypot(trm[2], trm[3]) || Math.abs(fontSize);
          // 장치공간 가로 전진폭 = tm 전진 전/후의 trm[4] 차이.
          const adv = mul(textState, mul(ntm, ctm))[4] - trm[4];
          // 렌더모드 1·5(획만)는 stroke 색, 그 외는 fill 색이 글자색.
          const col: [number, number, number] = renderMode === 1 || renderMode === 5 ? stroke : fill;
          const al = renderMode === 1 || renderMode === 5 ? strokeAlpha : fillAlpha;
          // 회전/전단 판정: trm 의 비대각 성분이 유의미하면 CSS matrix 로 기울인다(직립은 생략).
          const A = trm[0], B = trm[1], C = trm[2], D = trm[3];
          const sheared = Math.abs(B) > 1e-3 * (Math.abs(A) || 1) || Math.abs(C) > 1e-3 * (Math.abs(D) || 1);
          // CSS(y-down) 단위 선형부: local(1,0)→(A,-B)/size, local(0,1)→(-C,D)/size. 직립이면 [h,0,0,1].
          const rot: [number, number, number, number] | undefined = sheared && size > 0
            ? [A / size, -B / size, -C / size, D / size]
            : undefined;
          items.push({ x: trm[4], y: trm[5], size, text: ch, bold: font.bold, italic: font.italic, seq: seq++, ff: font.embedFamily, adv, color: [...col], alpha: al < 1 ? al : undefined, rot });
        }
        tm = ntm;
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
        images.push({ stream: xo, ctm: ctm.slice(), fill, seq: seq++, clip, alpha: fillAlpha < 1 ? fillAlpha : undefined });
      } else if (subName === "Form" && depth < MAX_FORM_DEPTH) {
        const mtxArr = doc.resolve(doc.get(xo.dict, "Matrix"));
        let fm: Mat = IDENT;
        if (Array.isArray(mtxArr) && mtxArr.length === 6)
          fm = mtxArr.map((v) => doc.numOf(v, 0)) as unknown as Mat;
        const formRes = doc.getDict(doc.get(xo.dict, "Resources")) ?? res;
        run(doc.decodeStream(xo), formRes, mul(fm, ctm), depth + 1, clip);
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
          case "q": gsStack.push({ ctm, fill: [...fill], stroke: [...stroke], lineWidth, clip, fillAlpha, strokeAlpha, dash: [...dash], dashPhase, cap, join, charSpace, wordSpace, hScale, leading, rise, renderMode, font, fontSize }); break;
          case "Q": { const s = gsStack.pop(); if (s) { ctm = s.ctm; fill = s.fill; stroke = s.stroke; lineWidth = s.lineWidth; clip = s.clip; fillAlpha = s.fillAlpha; strokeAlpha = s.strokeAlpha; dash = s.dash; dashPhase = s.dashPhase; cap = s.cap; join = s.join; charSpace = s.charSpace; wordSpace = s.wordSpace; hScale = s.hScale; leading = s.leading; rise = s.rise; renderMode = s.renderMode; font = s.font; fontSize = s.fontSize; } break; }
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
          case "sc": case "scn": {
            // scn 의 마지막 피연산자가 패턴명(PName)이면 색 성분이 아님 → 색 갱신 안 함(검정화 방지).
            const numComps = a.filter((v) => typeof v === "number").length;
            if (numComps >= 4) fill = cmyk(num(0), num(1), num(2), num(3));
            else if (numComps >= 3) fill = [clampByte(num(0)), clampByte(num(1)), clampByte(num(2))];
            else if (numComps === 1) { const v = clampByte(num(0)); fill = [v, v, v]; }
            break;
          }
          // 획(선) 색 + 선폭
          case "RG": stroke = [clampByte(num(0)), clampByte(num(1)), clampByte(num(2))]; break;
          case "G": { const v = clampByte(num(0)); stroke = [v, v, v]; break; }
          case "K": stroke = cmyk(num(0), num(1), num(2), num(3)); break;
          case "SC": case "SCN": {
            const numComps = a.filter((v) => typeof v === "number").length;
            if (numComps >= 4) stroke = cmyk(num(0), num(1), num(2), num(3));
            else if (numComps >= 3) stroke = [clampByte(num(0)), clampByte(num(1)), clampByte(num(2))];
            else if (numComps === 1) { const v = clampByte(num(0)); stroke = [v, v, v]; }
            break;
          }
          case "w": lineWidth = num(0); break;
          case "gs": if (a[0] instanceof PName) applyGs((a[0] as PName).name); break;
          case "d": { const arr = a[0]; dash = Array.isArray(arr) ? arr.map((v) => (typeof v === "number" ? v : 0)).filter((v) => v >= 0) : []; dashPhase = num(1); break; }
          case "J": cap = num(0); break;
          case "j": join = num(0); break;
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
          case "n": cmds = []; flushClip(); break; // 칠 없음 → 경로 폐기, 예약된 클립 활성화
          case "W": case "W*": pendingClip = clipIntersect(clip, pathBBox(cmds)); break; // 현재 경로의 경계상자를 다음 페인트 때 클립으로
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
  // 주석 외관: 페이지 콘텐츠 위(나중 seq)에 각자의 ctm 으로 그린다(폼필드·도장·텍스트노트 등).
  for (const an of annots ?? []) {
    try { run(doc.decodeStream(an.stream), an.resources ?? resources, an.ctm as Mat, 1, undefined); } catch { /* 한 주석 실패는 무시 */ }
  }
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
  let curEnd = 0; // 현재 런의 추정 오른쪽 끝(x) — estW 기반, 병합 거리 판정용
  let prevAdvEnd = 0; // 직전 글리프의 정밀 끝(x + adv) — 위치상 공백 간격 판정용
  const estW = (it: TextItem): number => {
    const cp = it.text.codePointAt(0) ?? 0;
    return it.size * (cp > 0x2e80 ? 1.0 : 0.5); // CJK 는 전각, 그 외 반각 근사
  };
  // 직전 글리프 끝부터 현재 글리프까지 간격이 단어 공백만큼 벌어졌는데 실제 공백 문자가
  // 없으면(TJ 음수보정·Td/Tm 재배치) 공백 1개를 끼워 넣어 단어가 붙는 것을 막는다.
  const advEnd = (it: TextItem): number => it.x + (it.adv ?? estW(it));
  for (const it of items) {
    const gap = cur ? it.x - prevAdvEnd : 0; // 직전 글리프 끝→현재 글리프 정밀 간격
    const merge =
      cur !== null &&
      Math.abs(it.y - cur.y) < cur.size * 0.45 && // 같은 줄
      it.size > cur.size * 0.8 && it.size < cur.size * 1.25 && // 같은 크기
      it.bold === cur.bold && it.italic === cur.italic && // 같은 굵기/기울임
      it.ff === cur.ff && // 같은 폰트(임베디드 family)
      sameColor(it.color, cur.color) && // 같은 글자색
      it.alpha === cur.alpha && // 같은 불투명도
      sameRot(it.rot, cur.rot) && // 같은 회전/전단(직립끼리·동일행렬끼리만)
      it.x >= curEnd - cur.size * 0.5 && // 역방향 큰 점프 아님
      gap <= cur.size * 0.5; // 열 경계(0.5em 초과 양수 간격)는 끊어 절대위치 보존(표 칸 침범 방지)
    if (merge && cur) {
      const needSpace =
        gap > cur.size * 0.25 && // 단어 공백(~0.25em) 만큼 벌어짐
        !/\s$/.test(cur.text) && !/^\s/.test(it.text); // 이미 공백이면 중복 안 함
      cur.text += (needSpace ? " " : "") + it.text;
      curEnd = it.x + estW(it);
      cur.w = curEnd - cur.x; // 런이 늘어날 때마다 원본 오른쪽 끝까지의 폭 갱신
    } else {
      cur = { ...it };
      out.push(cur);
      curEnd = it.x + estW(it);
      cur.w = curEnd - cur.x;
    }
    prevAdvEnd = advEnd(it);
  }
  // 순수 공백 런은 버린다(시각적 의미 없음).
  return out.filter((r) => r.text.trim() !== "");
}

/** 두 글자색이 같은지(기본 검정 취급). 런 결합 가부 판정용. */
function sameColor(a: [number, number, number] | undefined, b: [number, number, number] | undefined): boolean {
  const x = a ?? [0, 0, 0];
  const y = b ?? [0, 0, 0];
  return x[0] === y[0] && x[1] === y[1] && x[2] === y[2];
}

/** 두 회전/전단 행렬이 (근사적으로) 같은지. 둘 다 직립(undefined)이면 같음. */
function sameRot(a: [number, number, number, number] | undefined, b: [number, number, number, number] | undefined): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return Math.abs(a[0] - b[0]) < 1e-3 && Math.abs(a[1] - b[1]) < 1e-3 && Math.abs(a[2] - b[2]) < 1e-3 && Math.abs(a[3] - b[3]) < 1e-3;
}

/** 경로 명령(장치좌표)의 축정렬 경계상자 → 클립 사각형. 비-사각형 클립은 외접 사각형으로 근사. */
function pathBBox(cmds: PathCmd[]): ClipRect | undefined {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const cm of cmds) for (let i = 0; i + 1 < cm.c.length; i += 2) {
    const x = cm.c[i]!, y = cm.c[i + 1]!;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return x1 >= x0 && y1 >= y0 ? [x0, y0, x1, y1] : undefined;
}
/** 두 클립의 교집합. 한쪽이 없으면 다른쪽. 빈 교집합은 0크기(아무것도 안 보임)로. */
function clipIntersect(a: ClipRect | undefined, b: ClipRect | undefined): ClipRect | undefined {
  if (!a) return b;
  if (!b) return a;
  const r: ClipRect = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
  return r[2] >= r[0] && r[3] >= r[1] ? r : [a[0], a[1], a[0], a[1]];
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
