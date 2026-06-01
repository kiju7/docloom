/**
 * .ppt(PowerPoint 97-2003 바이너리) "PowerPoint Document" 스트림 공유 레코드 헬퍼.
 *
 * MS-PPT 레코드 헤더(8B): [verInst u16 LE][recType u16 LE][recLen u32 LE].
 * verInst 하위 4bit 가 0xF 면 컨테이너(자식 레코드를 품음), 아니면 atom(원자).
 *
 * 여기서는 미리보기(formats/ppt.ts)와 왕복(encode/decode)이 공유하는,
 * "텍스트 atom 을 등장 순서로 그 절대 바이트 오프셋과 함께 수집"하는 워커를 제공한다.
 *
 * 왕복 핵심: 텍스트 atom 은 문자 바이트만 담는다. 서식(런/문단)은 별도 레코드
 * (StyleTextPropAtom 0x0FA1 등)에 있으므로, 텍스트 atom 의 문자 바이트만 갈아끼우면
 * 서식은 자동으로 보존된다.
 */

export const REC_SLIDE = 0x03ee; // Slide 컨테이너
export const REC_TEXTCHARS = 0x0fa0; // TextCharsAtom (UTF-16LE)
export const REC_TEXTBYTES = 0x0fa8; // TextBytesAtom (ANSI 1B / Latin1)

export interface TextAtomLoc {
  /** 0x0FA0(chars, UTF-16LE) | 0x0FA8(bytes, Latin1). */
  recType: number;
  /** 헤더(8B) 시작 절대 오프셋. */
  headerOffset: number;
  /** 본문(문자 바이트) 시작 절대 오프셋(= headerOffset + 8). */
  bodyOffset: number;
  /** 본문 바이트 길이(= recLen). */
  bodyLength: number;
  /** 디코드된 텍스트(제어문자 원본 그대로; 미리보기용 정리는 별도). */
  text: string;
  /** 이 atom 이 등장하기 직전 가장 최근 Slide 컨테이너 시작 인덱스(없으면 -1). */
  slideIndex: number;
  /** 등장 순서(전역 atom 인덱스). data-atom 안정 id 의 일부. */
  order: number;
}

/** 텍스트 atom 본문 바이트 → 문자열(제어문자 보존). */
export function decodeAtomText(buf: Uint8Array, loc: { recType: number; bodyOffset: number; bodyLength: number }): string {
  const { recType, bodyOffset, bodyLength } = loc;
  let s = "";
  if (recType === REC_TEXTCHARS) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    for (let q = bodyOffset; q + 1 < bodyOffset + bodyLength; q += 2) s += String.fromCharCode(dv.getUint16(q, true));
  } else {
    for (let q = bodyOffset; q < bodyOffset + bodyLength; q++) s += String.fromCharCode(buf[q]!);
  }
  return s;
}

/**
 * "PowerPoint Document" 스트림을 순회하며 모든 텍스트 atom 을 등장 순서로 수집한다.
 * 컨테이너는 재귀적으로 들어가고, Slide 컨테이너(0x03EE) 경계를 추적한다.
 */
export function collectTextAtoms(buf: Uint8Array): TextAtomLoc[] {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const atoms: TextAtomLoc[] = [];
  let slideCounter = -1;

  const walk = (start: number, end: number): void => {
    let p = start;
    while (p + 8 <= end) {
      const verInst = dv.getUint16(p, true);
      const recType = dv.getUint16(p + 2, true);
      const recLen = dv.getUint32(p + 4, true);
      const bodyStart = p + 8;
      const bodyEnd = bodyStart + recLen;
      if (bodyEnd > end) break; // 잘린 꼬리 방어
      const isContainer = (verInst & 0x000f) === 0x000f;

      if (recType === REC_SLIDE) slideCounter++;

      if (isContainer) {
        walk(bodyStart, bodyEnd);
      } else if (recType === REC_TEXTCHARS || recType === REC_TEXTBYTES) {
        atoms.push({
          recType,
          headerOffset: p,
          bodyOffset: bodyStart,
          bodyLength: recLen,
          text: decodeAtomText(buf, { recType, bodyOffset: bodyStart, bodyLength: recLen }),
          slideIndex: slideCounter,
          order: atoms.length,
        });
      }
      p = bodyEnd;
    }
  };
  walk(0, buf.length);
  return atoms;
}

/**
 * 텍스트 → 해당 atom 타입의 본문 바이트.
 *   - TextBytesAtom(0x0FA8): 1바이트/문자(Latin1). 코드포인트 > 0xFF 는 인코딩 불가.
 *   - TextCharsAtom(0x0FA0): 2바이트/문자(UTF-16LE). BMP 외(서로게이트) 는 그대로 코드유닛.
 * 반환 null = 이 atom 타입으로 무손실 인코딩 불가(호출측이 거부/리포트).
 */
export function encodeAtomText(recType: number, text: string): Uint8Array | null {
  if (recType === REC_TEXTBYTES) {
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c > 0xff) return null; // Latin1 범위 초과 → 이 atom 으로 표현 불가
      out[i] = c;
    }
    return out;
  }
  // TextCharsAtom: UTF-16LE
  const out = new Uint8Array(text.length * 2);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < text.length; i++) dv.setUint16(i * 2, text.charCodeAt(i), true);
  return out;
}
