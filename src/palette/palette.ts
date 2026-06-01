/**
 * 스타일 팔레트 (Style Palette)
 *
 * docloom 의 심장. "닫힌 집합"으로서, LLM/HTML 이 참조할 수 있는 스타일을
 * 여기 정의된 것만으로 제한한다. 모르는 스타일은 fallback 으로 흡수.
 *
 *   HTML class  "s-<styleKey>"   ↔   docx pStyle(styleId)
 *
 * 예) <p class="s-body">  ↔  <w:pStyle w:val="본문"/>
 *
 * 이 매핑 표가 곧 "양식 보존"의 계약서다. encode 와 decode 가 동일한
 * 팔레트를 공유하기 때문에 왕복이 성립한다.
 */

export interface PaletteEntry {
  /** 모델/HTML 에서 쓰는 안정적인 키. class = "s-" + styleKey */
  styleKey: string;
  /**
   * 원본의 네이티브 스타일 식별자(문서마다 다를 수 있어 별도 관리).
   * 이름은 docx 유산이지만 동작은 포맷 무관 — hwpx 는 hh:style 의 id(styleIDRef),
   * hwp 는 DocInfo STYLE 레코드의 인덱스를 이 필드에 담아 그대로 재사용한다.
   */
  docxStyleId: string;
  /** 이 키가 매핑되는 HTML 태그 (미리보기·시맨틱용) */
  htmlTag: "p" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "li";
}

export interface Palette {
  id: string;
  entries: PaletteEntry[];
  /** 매칭 실패 시 떨어지는 기본 키. 반드시 entries 안에 존재해야 한다. */
  fallbackStyleKey: string;
}

/**
 * 기본 팔레트(데모용). 실제로는 문서별 styles.xml 을 스캔해
 * buildPaletteFromStyles() 로 동적으로 만드는 걸 목표로 한다(추후).
 */
export const DEFAULT_PALETTE: Palette = {
  id: "default-v0",
  fallbackStyleKey: "body",
  entries: [
    { styleKey: "title", docxStyleId: "Title", htmlTag: "h1" },
    { styleKey: "heading1", docxStyleId: "Heading1", htmlTag: "h1" },
    { styleKey: "heading2", docxStyleId: "Heading2", htmlTag: "h2" },
    { styleKey: "heading3", docxStyleId: "Heading3", htmlTag: "h3" },
    { styleKey: "body", docxStyleId: "Normal", htmlTag: "p" },
    { styleKey: "listItem", docxStyleId: "ListParagraph", htmlTag: "li" },
  ],
};

const byStyleKey = (p: Palette) =>
  new Map(p.entries.map((e) => [e.styleKey, e]));
const byDocxId = (p: Palette) =>
  new Map(p.entries.map((e) => [e.docxStyleId, e]));

/** docx styleId → 팔레트 styleKey (encode 방향). 모르면 fallback. */
export function styleKeyFromDocxId(p: Palette, docxStyleId: string | undefined): string {
  if (!docxStyleId) return p.fallbackStyleKey;
  return byDocxId(p).get(docxStyleId)?.styleKey ?? p.fallbackStyleKey;
}

/** 팔레트 styleKey → docx styleId (decode 방향). 모르면 fallback 의 id. */
export function docxIdFromStyleKey(p: Palette, styleKey: string): string {
  const entry = byStyleKey(p).get(styleKey);
  if (entry) return entry.docxStyleId;
  const fb = byStyleKey(p).get(p.fallbackStyleKey);
  if (!fb) throw new Error(`fallbackStyleKey '${p.fallbackStyleKey}' 가 팔레트에 없음`);
  return fb.docxStyleId;
}

/** HTML class("s-body") → styleKey. 유효한 s- class 가 없으면 undefined. */
export function tryStyleKeyFromClass(p: Palette, className: string | undefined): string | undefined {
  if (!className) return undefined;
  const keys = byStyleKey(p);
  for (const c of className.split(/\s+/)) {
    if (c.startsWith("s-")) {
      const key = c.slice(2);
      if (keys.has(key)) return key;
    }
  }
  return undefined;
}

/** HTML class("s-body") → styleKey("body"). 미지정/미지원이면 fallback. */
export function styleKeyFromClass(p: Palette, className: string | undefined): string {
  return tryStyleKeyFromClass(p, className) ?? p.fallbackStyleKey;
}

/** HTML 태그(h1/li/p…)에 대응하는 팔레트 styleKey(첫 매칭). class 가 없을 때 추론용. */
export function styleKeyForHtmlTag(p: Palette, htmlTag: string): string | undefined {
  return p.entries.find((e) => e.htmlTag === htmlTag)?.styleKey;
}

/** styleKey → HTML class. */
export function classFromStyleKey(styleKey: string): string {
  return `s-${styleKey}`;
}

/** 해당 styleKey 의 HTML 태그. */
export function htmlTagFromStyleKey(p: Palette, styleKey: string): PaletteEntry["htmlTag"] {
  return byStyleKey(p).get(styleKey)?.htmlTag ?? "p";
}
