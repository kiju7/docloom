/**
 * .doc(Word 97-2003 바이너리, OLE2/CFB) FIB + piece table(CLX) 파서 — 순수 TypeScript.
 *
 * .doc 의 텍스트는 "WordDocument" 스트림에 raw 로 들어있지만, 논리적 문자 순서(CP)→
 * 물리적 파일오프셋(FC) 매핑은 Table 스트림("1Table" 또는 "0Table")의 **piece table(CLX)**
 * 가 정의한다. 한 piece 는 압축(cp1252, 1B/char) 또는 비압축(UTF-16LE, 2B/char)이다.
 *
 * 이 모듈이 하는 일:
 *   1) FIB(WordDocument 선두) 헤더에서 fWhichTblStm 비트와 fcClx/lcbClx 를 읽는다.
 *   2) Table 스트림의 fcClx 위치에서 CLX(Prc* + Pcdt) 를 파싱해 piece 배열을 만든다.
 *   3) 각 piece 의 텍스트를 WordDocument 에서 읽어 디코드한다.
 *
 * 미지원(정직하게): 서식 런(CHPX/PAPX·grpprl)·필드(field)·표·이미지·각주/머리말 구분·
 *   nFib 별 미세 차이. fcClx/lcbClx 의 FibRgFcLcb97 고정 오프셋(0x01A2/0x01A6)을 사용한다.
 *   (Word 97 이후 모든 nФib 에서 FibRgFcLcb97 이 존재하며 이 오프셋은 안정적이다.)
 */

/** FIB 에서 추출한 핵심 필드. */
export interface FibInfo {
  /** Table 스트림 이름: fWhichTblStm 비트(0x0200@0x000A)가 1 이면 "1Table" 아니면 "0Table". */
  tableStreamName: "1Table" | "0Table";
  /** piece table(CLX)의 Table 스트림 내 오프셋. */
  fcClx: number;
  /** CLX 바이트 길이. */
  lcbClx: number;
  /** 레거시 텍스트 span(검증/폴백용). */
  fcMin: number;
  fcMac: number;
  /** nFib(파일 버전). 진단용. */
  nFib: number;

  // --- 서식(미리보기 충실도)용 FibRgFcLcb97 필드들 (모두 Table 스트림 기준 오프셋) ---
  /** 스타일시트(STSH). istd→문단/글자 기본서식 해석용. */
  fcStshf: number;
  lcbStshf: number;
  /** 문단속성 bin table(PlcfBtePapx). FC→PAPX FKP 페이지. */
  fcPlcfBtePapx: number;
  lcbPlcfBtePapx: number;
  /** 글자속성 bin table(PlcfBteChpx). FC→CHPX FKP 페이지. */
  fcPlcfBteChpx: number;
  lcbPlcfBteChpx: number;
  /** 섹션 plex(PlcfSed). 섹션 경계(페이지/단/용지). */
  fcPlcfSed: number;
  lcbPlcfSed: number;
  /** 폰트이름 테이블(SttbfFfn). ftc→글꼴명. */
  fcSttbfFfn: number;
  lcbSttbfFfn: number;
  /** 머리말/꼬리말 plex(PlcfHdd). 스토리 경계 CP. */
  fcPlcfHdd: number;
  lcbPlcfHdd: number;
  /** 본문 도형 앵커(PlcfspaMom, FSPA). CP→도형 위치+spid. */
  fcPlcfspaMom: number;
  lcbPlcfspaMom: number;
  /** 목록 정의 테이블(PlcfLst, LSTF+LVL). 자동번호 종류/시작/레벨템플릿. */
  fcPlcfLst: number;
  lcbPlcfLst: number;
  /** 목록 적용 테이블(PlfLfo). ilfo→lsid 매핑. */
  fcPlfLfo: number;
  lcbPlfLfo: number;
  /** OfficeArt 드로잉 컨테이너(DggInfo). spid→도형 종류/선/채움 속성. */
  fcDggInfo: number;
  lcbDggInfo: number;

  // --- 텍스트 영역 길이(FibRgLw97, 진단/머리말꼬리말 CP 매핑용) ---
  /** 본문 텍스트 CP 길이. */
  ccpText: number;
  /** 각주 텍스트 CP 길이. */
  ccpFtn: number;
  /** 머리말/꼬리말 텍스트 CP 길이. */
  ccpHdd: number;
  /** 텍스트박스 텍스트 CP 길이. */
  ccpTxbx: number;
}

/**
 * 한 piece(plcfpcd 의 PCD 하나)에 대한 위치 정보.
 *   - cpStart/cpEnd: 논리 문자 위치 구간 [cpStart, cpEnd) (CP 단위).
 *   - charCount: cpEnd - cpStart.
 *   - compressed: true 면 cp1252 1B/char, false 면 UTF-16LE 2B/char.
 *   - fcStart: WordDocument 스트림 내 이 piece 의 실제 바이트 시작 오프셋.
 *   - byteLength: 이 piece 가 WordDocument 에서 차지하는 바이트 수
 *       (compressed: charCount, 아니면 charCount*2).
 */
export interface Piece {
  index: number;
  cpStart: number;
  cpEnd: number;
  charCount: number;
  compressed: boolean;
  fcStart: number;
  byteLength: number;
}

/** WordDocument 스트림 선두의 FIB 에서 핵심 필드를 읽는다. */
export function parseFib(wordDocument: Uint8Array): FibInfo {
  if (wordDocument.length < 0x01a6 + 4) {
    throw new Error("DOC: WordDocument 스트림이 너무 짧아 FIB 를 읽을 수 없습니다.");
  }
  const dv = new DataView(wordDocument.buffer, wordDocument.byteOffset, wordDocument.byteLength);

  const wIdent = dv.getUint16(0x0000, true);
  if (wIdent !== 0xa5ec) {
    // wIdent(0xA5EC) 는 Word 97-2003 바이너리 매직. 다르면 비-doc 또는 손상.
    throw new Error(`DOC: FIB wIdent 불일치(0x${wIdent.toString(16)}), Word 97-2003 .doc 가 아닙니다.`);
  }
  const nFib = dv.getUint16(0x0002, true);

  // flags @ 0x000A (u16). fWhichTblStm = bit 0x0200.
  const flags = dv.getUint16(0x000a, true);
  const fWhichTblStm = (flags & 0x0200) !== 0;

  // 레거시 텍스트 span(폴백/검증).
  const fcMin = dv.getInt32(0x0018, true);
  const fcMac = dv.getInt32(0x001c, true);

  // FibRgFcLcb97 고정 오프셋(Word 97 이후 모든 nFib 에서 안정적).
  const u32 = (off: number) => (off + 4 <= wordDocument.length ? dv.getUint32(off, true) : 0);
  const fcClx = u32(0x01a2);
  const lcbClx = u32(0x01a6);

  return {
    tableStreamName: fWhichTblStm ? "1Table" : "0Table",
    fcClx,
    lcbClx,
    fcMin,
    fcMac,
    nFib,
    fcStshf: u32(0x00a2),
    lcbStshf: u32(0x00a6),
    fcPlcfBtePapx: u32(0x0102),
    lcbPlcfBtePapx: u32(0x0106),
    fcPlcfBteChpx: u32(0x00fa),
    lcbPlcfBteChpx: u32(0x00fe),
    fcPlcfSed: u32(0x00ca),
    lcbPlcfSed: u32(0x00ce),
    fcSttbfFfn: u32(0x011a),
    lcbSttbfFfn: u32(0x011e),
    fcPlcfHdd: u32(0x00f2),
    lcbPlcfHdd: u32(0x00f6),
    fcPlcfspaMom: u32(0x01da),
    lcbPlcfspaMom: u32(0x01de),
    fcPlcfLst: u32(0x02e2),
    lcbPlcfLst: u32(0x02e6),
    fcPlfLfo: u32(0x02ea),
    lcbPlfLfo: u32(0x02ee),
    fcDggInfo: u32(0x022a),
    lcbDggInfo: u32(0x022e),
    ccpText: u32(0x004c),
    ccpFtn: u32(0x0050),
    ccpHdd: u32(0x0054),
    ccpTxbx: u32(0x0064),
  };
}

/** PCD 의 fc(부호없는 32bit)를 압축여부/실제 오프셋으로 해석. */
function decodeFc(fc: number): { compressed: boolean; fcStart: number } {
  // bit 0x40000000(fCompressed): 1 이면 cp1252 1B/char, 실제오프셋 = (fc & 0x3FFFFFFF)/2.
  const compressed = (fc & 0x40000000) !== 0;
  const fcStart = compressed ? (fc & 0x3fffffff) / 2 : fc & 0x3fffffff;
  return { compressed, fcStart };
}

/**
 * Table 스트림의 fcClx 위치에서 CLX 를 파싱해 piece 배열을 만든다.
 *
 * CLX 레이아웃(MS-DOC):
 *   Clx = RgPrc* Pcdt
 *   RgPrc 항목: 0x01 [cbGrpprl(u16)] [Prc bytes]  → 건너뛴다(서식 prop, 텍스트와 무관).
 *   Pcdt: 0x02 [lcb(u32)] [PlcPcd(lcb 바이트)]
 *   PlcPcd: (n+1)개의 CP(u32) 배열 + n개의 PCD(8B) 배열.
 *     PCD: +0 u16(flags) +2 fc(u32) +6 u16(prm)  → fc 만 사용.
 */
export function parsePieceTable(tableStream: Uint8Array, fcClx: number, lcbClx: number): Piece[] {
  if (fcClx < 0 || fcClx + lcbClx > tableStream.length) {
    throw new Error("DOC: CLX 가 Table 스트림 범위를 벗어납니다(fcClx/lcbClx 손상).");
  }
  const dv = new DataView(tableStream.buffer, tableStream.byteOffset, tableStream.byteLength);
  let p = fcClx;
  const end = fcClx + lcbClx;

  // 선행 RgPrc(0x01) 블록들을 건너뛴다.
  while (p < end) {
    const tag = dv.getUint8(p);
    if (tag === 0x01) {
      if (p + 3 > end) throw new Error("DOC: CLX Prc 헤더가 잘렸습니다.");
      const cbGrpprl = dv.getUint16(p + 1, true);
      p += 3 + cbGrpprl;
    } else {
      break;
    }
  }

  if (p >= end || dv.getUint8(p) !== 0x02) {
    throw new Error("DOC: CLX 에서 Pcdt(0x02) 마커를 찾지 못했습니다.");
  }
  p += 1;
  if (p + 4 > end) throw new Error("DOC: CLX Pcdt lcb 가 잘렸습니다.");
  const lcb = dv.getUint32(p, true);
  p += 4;
  const plcStart = p;
  const plcEnd = p + lcb;
  if (plcEnd > tableStream.length) throw new Error("DOC: PlcPcd 가 Table 스트림 범위를 벗어납니다.");

  // PlcPcd: (n+1) CP(u32) + n PCD(8B).  lcb = (n+1)*4 + n*8 = 12n + 4 → n = (lcb-4)/12.
  if (lcb < 4 || (lcb - 4) % 12 !== 0) {
    throw new Error(`DOC: PlcPcd 크기(${lcb})가 12n+4 형태가 아닙니다.`);
  }
  const n = (lcb - 4) / 12;

  const cps: number[] = [];
  for (let i = 0; i <= n; i++) cps.push(dv.getUint32(plcStart + i * 4, true));
  const pcdBase = plcStart + (n + 1) * 4;

  const pieces: Piece[] = [];
  for (let i = 0; i < n; i++) {
    const pcdOff = pcdBase + i * 8;
    const fc = dv.getUint32(pcdOff + 2, true);
    const { compressed, fcStart } = decodeFc(fc);
    const cpStart = cps[i]!;
    const cpEnd = cps[i + 1]!;
    const charCount = cpEnd - cpStart;
    pieces.push({
      index: i,
      cpStart,
      cpEnd,
      charCount,
      compressed,
      fcStart,
      byteLength: compressed ? charCount : charCount * 2,
    });
  }
  return pieces;
}

/**
 * CLX 를 raw 수준까지 파싱: piece 배열 + 각 PCD 의 원본 8B + Pcdt 이전 RgPrc 접두 바이트.
 * relayout(piece 분할 재작성)에서 PCD 머리/prm 을 보존하고 RgPrc 를 그대로 재방출하는 데 쓴다.
 */
export function parseClxRaw(
  tableStream: Uint8Array,
  fcClx: number,
  lcbClx: number,
): { pieces: Piece[]; pcdRaw: Uint8Array[]; rgprcBytes: Uint8Array } {
  const pieces = parsePieceTable(tableStream, fcClx, lcbClx);
  const dv = new DataView(tableStream.buffer, tableStream.byteOffset, tableStream.byteLength);
  let p = fcClx;
  const end = fcClx + lcbClx;
  // RgPrc(0x01) 접두 길이 측정.
  while (p < end && dv.getUint8(p) === 0x01) {
    const cbGrpprl = dv.getUint16(p + 1, true);
    p += 3 + cbGrpprl;
  }
  const rgprcBytes = tableStream.slice(fcClx, p); // Pcdt 이전 전부
  // Pcdt: 0x02 + lcb(u32) + PlcPcd.
  const lcb = dv.getUint32(p + 1, true);
  const plcStart = p + 5;
  const n = (lcb - 4) / 12;
  const pcdBase = plcStart + (n + 1) * 4;
  const pcdRaw: Uint8Array[] = [];
  for (let i = 0; i < n; i++) pcdRaw.push(tableStream.slice(pcdBase + i * 8, pcdBase + i * 8 + 8));
  return { pieces, pcdRaw, rgprcBytes };
}

/** cp1252 → 유니코드(상위 영역의 windows-1252 특수 매핑 포함). 0x80-0x9F 만 특수. */
const CP1252_HIGH: Record<number, number> = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026,
  0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160,
  0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019,
  0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
  0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153,
  0x9e: 0x017e, 0x9f: 0x0178,
};

/** 한 piece 의 텍스트를 WordDocument 에서 읽어 디코드. */
export function readPieceText(wordDocument: Uint8Array, piece: Piece): string {
  const { fcStart, charCount, compressed } = piece;
  if (compressed) {
    if (fcStart + charCount > wordDocument.length) {
      throw new Error(`DOC: piece ${piece.index}(압축) 가 WordDocument 범위를 벗어납니다.`);
    }
    let s = "";
    for (let i = 0; i < charCount; i++) {
      const b = wordDocument[fcStart + i]!;
      s += String.fromCharCode(b >= 0x80 && b <= 0x9f ? CP1252_HIGH[b] ?? b : b);
    }
    return s;
  }
  if (fcStart + charCount * 2 > wordDocument.length) {
    throw new Error(`DOC: piece ${piece.index}(UTF-16) 가 WordDocument 범위를 벗어납니다.`);
  }
  const dv = new DataView(wordDocument.buffer, wordDocument.byteOffset, wordDocument.byteLength);
  let s = "";
  for (let i = 0; i < charCount; i++) s += String.fromCharCode(dv.getUint16(fcStart + i * 2, true));
  return s;
}

/**
 * 길이 보존 편집을 위한 인코딩: 편집 텍스트를 piece 의 원래 압축방식으로 재인코딩한다.
 * 같은 문자 수면 같은 바이트 길이가 보장된다(압축: 1B/char, 비압축: 2B/char).
 * 인코딩 불가(압축 piece 인데 cp1252 로 표현 못 하는 문자)면 null 을 반환.
 */
export function encodePieceText(text: string, compressed: boolean): Uint8Array | null {
  const chars = [...text];
  if (compressed) {
    // cp1252 역매핑. 표현 불가 문자가 있으면 null.
    const inv = new Map<number, number>();
    for (const [k, v] of Object.entries(CP1252_HIGH)) inv.set(v, Number(k));
    const out = new Uint8Array(chars.length);
    for (let i = 0; i < chars.length; i++) {
      const cp = chars[i]!.charCodeAt(0);
      if (cp <= 0x7f || (cp >= 0xa0 && cp <= 0xff)) {
        out[i] = cp;
      } else if (inv.has(cp)) {
        out[i] = inv.get(cp)!;
      } else {
        return null; // cp1252 로 표현 불가
      }
    }
    return out;
  }
  // 비압축: UTF-16LE. 서로게이트 쌍(charCount 가 코드유닛 기준이어야 함)을 고려해
  // 코드유닛 단위로 인코딩한다.
  const units: number[] = [];
  for (let i = 0; i < text.length; i++) units.push(text.charCodeAt(i));
  const out = new Uint8Array(units.length * 2);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < units.length; i++) dv.setUint16(i * 2, units[i]!, true);
  return out;
}
