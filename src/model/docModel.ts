/**
 * 중간 문서 모델 (Intermediate Document Model)
 *
 * docx ↔ HTML 변환의 "가운데"에 놓이는 블록 트리.
 * - encode: docx(OOXML) → DocModel → HTML
 * - decode: HTML → DocModel → docx(OOXML)
 *
 * 이 모델은 "내용 + 어떤 스타일을 참조하는지" 만 담는다.
 * 실제 스타일 정의(styles.xml 등)는 절대 여기 들어오지 않는다 → Manifest 가 보관.
 */

/** 인라인 텍스트 조각. 직접서식(굵게/기울임)은 의미적 mark 로만 표현한다. */
export interface Run {
  text: string;
  marks?: Mark[];
  /**
   * 원본 런의 비-마크 직접서식(색·크기·폰트·형광 등)을 담은 w:rPr 조각의 토큰.
   * Manifest.props[propsRef] 에 원본 OOXML 이 보관된다. decode 시 현재 marks 와
   * 병합해 복원 → 색·크기 같은 서식이 왕복에서 사라지지 않는다. (없으면 보존할 서식 없음)
   */
  propsRef?: string;
  /**
   * 이미지·도형·OLE 등 텍스트가 아닌 런을 통째로 보존하는 토큰(frozen run).
   * Manifest.frozen[frozenRef] 에 원본 w:r OOXML 이 보관되고, LLM 편집 HTML 에는
   * 짧은 자리표시자(<span data-frozen-run>)만 나간다 → 이미지 바이트가 LLM 으로 가지 않고
   * (토큰 절약) decode 시 원본 그대로 복원된다. 이게 있으면 text/marks 는 의미 없음.
   */
  frozenRef?: string;
  /** frozen run 의 사람이 읽는 라벨(예: "[그림]"). 미리보기/편집 표시용. */
  label?: string;
}

export type Mark = "bold" | "italic" | "underline" | "strike";

/** 모든 블록의 공통부. styleKey 는 팔레트의 "닫힌 집합" 중 하나여야 한다. */
interface BlockBase {
  /** 팔레트 키. 예: "title" | "body" | "heading1" ... (class="s-<styleKey>") */
  styleKey: string;
  /**
   * 원본 문단의 직접서식(정렬 w:jc·들여쓰기·간격·번호매기기·테두리 등)을 담은
   * w:pPr 조각의 토큰. Manifest.props[propsRef] 에 원본 OOXML 이 보관된다.
   * decode 시 pStyle 만 현재 styleKey 로 교체하고 나머지는 그대로 복원.
   * (pStyle 외 직접서식이 없으면 undefined)
   */
  propsRef?: string;
}

export interface Paragraph extends BlockBase {
  type: "paragraph";
  runs: Run[];
}

export interface Heading extends BlockBase {
  type: "heading";
  level: 1 | 2 | 3 | 4 | 5 | 6;
  runs: Run[];
}

export interface ListItem extends BlockBase {
  type: "listItem";
  ordered: boolean;
  /** 들여쓰기 깊이 (0부터) */
  level: number;
  runs: Run[];
}

export interface TableCell {
  styleKey: string;
  blocks: Block[]; // 셀 안에도 블록이 들어갈 수 있음 (재귀)
  /** 가로/세로 병합 정보 — v0 에서는 보존만, 편집은 막는다 */
  colSpan?: number;
  rowSpan?: number;
  /**
   * 편집 가능 표(editableTables) 의 셀 식별자(data-cell="tbl-N:row:col").
   * 있으면 decode 가 원본 표 XML(Table.sourceRef) 의 해당 셀 텍스트만 교체한다(서식 보존).
   */
  cellRef?: string;
  /** 편집 가능 표 셀의 평문 텍스트(편집 표면에 노출/되읽기되는 값). */
  text?: string;
}

export interface TableRow {
  cells: TableCell[];
}

export interface Table extends BlockBase {
  type: "table";
  rows: TableRow[];
  /**
   * 편집 가능 표면 원본 표 XML 토큰(Manifest.frozen[sourceRef] = 원본 w:tbl/hp:tbl).
   * 있으면 decode 는 표를 새로 짓지 않고, 원본을 가져와 cellRef 가 가리키는 셀 텍스트만
   * 갈아끼운다 → 테두리·셀폭·병합 등 모든 서식 보존. (없으면 미리보기용 expandTables 표)
   */
  sourceRef?: string;
}

/**
 * Frozen 블록 = docloom 이 아직 "이해"하지 못하는 원본 조각.
 * (도형, 텍스트박스, 복잡한 필드, 미지원 요소 등)
 *
 * 원본 OOXML 을 Manifest 에 통째로 보관하고, HTML 에는 자리표시자만 남긴다.
 * → 미지원 요소가 있어도 왕복이 절대 깨지지 않게 하는 안전장치.
 */
export interface FrozenBlock {
  type: "frozen";
  /** Manifest.frozen[refId] 로 원본 OOXML 을 찾는 키 */
  refId: string;
  /** 사람이 미리보기에서 알아볼 수 있는 라벨 (선택) */
  label?: string;
}

export type Block =
  | Paragraph
  | Heading
  | ListItem
  | Table
  | FrozenBlock;

export interface DocModel {
  blocks: Block[];
}
