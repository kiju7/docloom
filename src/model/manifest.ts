/**
 * Manifest = "복원 키트".
 *
 * encode 시 HTML 과 짝을 이루어 함께 나오는, 당신 코드만 보는 사이드카.
 * LLM/사람은 HTML 만 만지고 Manifest 는 손대지 않는다.
 * decode = Manifest(원본 골격) + 편집된 HTML(내용) → docx 재조립.
 *
 * 핵심 전략(v0): 원본 docx 전체를 그대로 보관한다.
 *   - styles.xml / numbering.xml / 머리말·꼬리말 / 이미지 / 관계(rels) / sectPr ...
 *     전부 원본 그대로 유지 → 양식이 물리적으로 깨질 수 없음.
 *   - decode 는 word/document.xml 의 "본문(body)" 만 HTML 기준으로 재생성하고,
 *     나머지 part 는 originalParts 에서 그대로 가져다 다시 zip 한다.
 *
 * 멀티포맷 주의: 이 구조는 포맷 무관이다. docx/hwpx 는 zip 파트, hwp 는 CFB 스트림을
 * 동일하게 originalParts 에 담는다(컨테이너 종류는 container 로 구분). 포맷별 골격
 * 메타데이터(섹션 경로·압축 플래그 등)는 native 에 둔다.
 */
export interface Manifest {
  /** docloom manifest 스키마 버전 */
  version: 1;

  /**
   * 원본 문서의 모든 컨테이너 엔트리 (경로 → 바이트). 편집 불가 영역의 원천.
   *   - docx/hwpx(zip): zip 파트 경로 (예: "word/document.xml", "Contents/section0.xml")
   *   - hwp(cfb): CFB 스트림 경로 (예: "DocInfo", "BodyText/Section0", "FileHeader")
   */
  originalParts: Record<string, Uint8Array>;

  /** 이 manifest 가 어느 포맷인지. decode 어댑터 선택·검증용. (구버전 manifest 는 docx 로 간주) */
  format?: import("../core/format.js").OfficeFormat;

  /** 원본 컨테이너 종류. zip(docx/hwpx) | cfb(hwp) | text(csv) | pdf. */
  container?: "zip" | "cfb" | "text" | "pdf";

  /**
   * 포맷별 골격 메타데이터(문자열 값). decode 가 본문을 어디에 어떻게 되끼울지 알 때 쓴다.
   *   - hwpx: { sectionPaths: JSON 배열 } 등
   *   - hwp:  { sections, compress, ... } 등
   * (원본 바이트는 originalParts 에 있고, 여기는 그 위의 가벼운 인덱스/플래그만.)
   */
  native?: Record<string, string>;

  /**
   * 본문 끝 sectPr(섹션 속성: 용지·여백·머리말 참조 등) 원본 XML.
   * 본문을 재생성해도 이건 그대로 다시 붙인다.
   */
  bodySectPr?: string;

  /**
   * Frozen 블록 보관소. refId → 원본 OOXML 조각(문자열).
   * decode 시 자리표시자를 이 원본으로 그대로 치환.
   */
  frozen: Record<string, string>;

  /**
   * 직접서식 보관소. 토큰 → 원본 w:pPr/w:rPr OOXML 조각(문자열).
   *   - "pp-N" → 문단 직접서식(정렬·들여쓰기·간격·번호·테두리…)
   *   - "rp-N" → 런 직접서식(색·크기·폰트·형광…)
   * decode 시 본문을 재생성하면서 이 조각들을 다시 부착 → 서식이 왕복에서 보존된다.
   * (편집 채널인 HTML 에는 data-pp / data-rp 토큰만 실려 나가고, 실제 서식은 여기 보관.)
   */
  props: Record<string, string>;

  /**
   * 팔레트 식별자. encode/decode 가 같은 팔레트를 쓰는지 검증용.
   */
  paletteId: string;
}
