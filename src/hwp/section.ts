/**
 * HWP BodyText 섹션의 "문단 단위(ParaUnit)" 모델 — encode/decode 가 공유.
 *
 * 섹션 레코드 스트림을 문단으로 묶는다. 문단 경계는 base level(첫 PARA_HEADER 의 level)의
 * PARA_HEADER 다. 표/그림 등 컨트롤은 더 높은 level 의 자식 레코드(셀 문단 포함)로 들어오므로
 * 같은 문단에 속한다.
 *
 * 편집 가능(editable) 문단의 조건(보수적):
 *   - 컨트롤(CTRL_HEADER) 없음(표·그림·필드 없음)
 *   - rangeTag 0개(범위태그가 텍스트 위치를 참조하므로 텍스트 재작성과 충돌)
 *   - PARA_TEXT 가 순수 텍스트(제어문자/개체 없음)
 * charShape 가 여러 개(한 문단에 글자모양이 섞임)여도 편집 가능하다 — encode 가 글자모양
 * 경계로 런을 쪼개 각 런에 charShapeId 를 실어 보내고(propsRef), decode 가 런 길이로
 * PARA_CHAR_SHAPE 를 재구성한다. 만족하면 텍스트 갈아끼우기·문단 추가/삭제까지 안전하게
 * 재직렬화된다. 아니면 frozen(원본 레코드 보존).
 */
import {
  type HwpRecord,
  parseRecords,
  HWPTAG_PARA_HEADER,
  HWPTAG_PARA_TEXT,
  HWPTAG_PARA_CHAR_SHAPE,
  HWPTAG_PARA_LINE_SEG,
  HWPTAG_CTRL_HEADER,
  readParaHeader,
  extractParaText,
} from "./record.js";

export interface ParaUnit {
  records: HwpRecord[];
  baseLevel: number;
  editable: boolean;
  text: string;
  styleId: number;
  /** PARA_HEADER payload(템플릿 복제용). */
  headerData?: Uint8Array;
  /** PARA_CHAR_SHAPE payload(글자모양 경계 테이블 — 8바이트(pos,id) × N). */
  charShapeData?: Uint8Array;
  /** PARA_CHAR_SHAPE 를 (pos, shapeId) 런으로 푼 것(없으면 [{pos:0,shapeId:0}]). */
  charRuns: { pos: number; shapeId: number }[];
  /** PARA_LINE_SEG payload(텍스트 미변경 시 재사용). */
  lineSegData?: Uint8Array;
}

/** PARA_CHAR_SHAPE 페이로드(8바이트 (UINT32 pos, UINT32 shapeId) 배열)를 런으로 파싱. */
function parseCharRuns(data: Uint8Array | undefined): { pos: number; shapeId: number }[] {
  if (!data || data.length < 8) return [{ pos: 0, shapeId: 0 }];
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const out: { pos: number; shapeId: number }[] = [];
  for (let i = 0; i + 8 <= data.length; i += 8) {
    out.push({ pos: dv.getUint32(i, true), shapeId: dv.getUint32(i + 4, true) });
  }
  return out.length ? out : [{ pos: 0, shapeId: 0 }];
}

/** 섹션 레코드 → 문단 단위 목록. */
export function groupParagraphs(records: HwpRecord[]): ParaUnit[] {
  const firstHeader = records.find((r) => r.tag === HWPTAG_PARA_HEADER);
  const baseLevel = firstHeader ? firstHeader.level : 0;

  const units: ParaUnit[] = [];
  let cur: HwpRecord[] | undefined;
  const flush = () => {
    if (cur && cur.length) units.push(analyze(cur, baseLevel));
    cur = undefined;
  };
  for (const r of records) {
    if (r.tag === HWPTAG_PARA_HEADER && r.level === baseLevel) {
      flush();
      cur = [r];
    } else if (cur) {
      cur.push(r);
    } else {
      cur = [r];
      flush();
    }
  }
  flush();
  return units;
}

function analyze(records: HwpRecord[], baseLevel: number): ParaUnit {
  const header = records.find((r) => r.tag === HWPTAG_PARA_HEADER);
  const hf = header ? readParaHeader(header.data) : undefined;
  const textRec = records.find((r) => r.tag === HWPTAG_PARA_TEXT && r.level === baseLevel + 1);
  const charShapeRec = records.find((r) => r.tag === HWPTAG_PARA_CHAR_SHAPE && r.level === baseLevel + 1);
  const lineSegRec = records.find((r) => r.tag === HWPTAG_PARA_LINE_SEG && r.level === baseLevel + 1);
  const hasCtrl = records.some((r) => r.tag === HWPTAG_CTRL_HEADER);

  const extracted = textRec ? extractParaText(textRec.data) : { text: "", hadObject: false };
  const text = extracted.text;
  const editable =
    !!header &&
    !hasCtrl &&
    (hf?.rangeTagCount ?? 0) === 0 &&
    !extracted.hadObject;

  return {
    records,
    baseLevel,
    editable,
    text,
    styleId: hf?.styleId ?? 0,
    headerData: header?.data,
    charShapeData: charShapeRec?.data,
    charRuns: parseCharRuns(charShapeRec?.data),
    lineSegData: lineSegRec?.data,
  };
}

/** 섹션 압축해제 바이트 → 문단 단위 목록(편의). */
export function sectionToParaUnits(decompressed: Uint8Array): ParaUnit[] {
  return groupParagraphs(parseRecords(decompressed));
}
