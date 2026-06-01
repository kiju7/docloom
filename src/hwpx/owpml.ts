/**
 * HWPX(OWPML) 특화 헬퍼 — docx/ooxml.ts 에 대응.
 *
 * HWPX 는 ZIP 컨테이너 + XML 본문이라 docx 와 구조 철학이 같다. 포맷 무관 XML
 * 프리미티브(core/xml)는 그대로 쓰고, 여기서는 OWPML 특화 읽기/쓰기만 둔다.
 *
 * HWPX 본문 구조(Contents/sectionN.xml):
 *   hs:sec > [ hp:p ... ]
 *   hp:p   @paraPrIDRef @styleIDRef ...   (문단)
 *   hp:p   > hp:run @charPrIDRef > hp:t   (런 → 텍스트)
 *   hp:run > hp:secPr|hp:ctrl|hp:tbl|hp:pic|hp:equation ...  (텍스트 아닌 개체 → frozen)
 *
 * 서식은 ID 참조(charPrIDRef/paraPrIDRef/styleIDRef → Contents/header.xml)로 표현된다.
 * docx 처럼 인라인 w:rPr 이 아니므로, 직접서식 "조각"이 아니라 "참조 ID 문자열"을 보존한다.
 */
import {
  type XmlNode,
  parseXml,
  buildXml,
  tagOf,
  childrenOf,
  textOf,
  attrOf,
  findChild,
  findChildren,
  setChildren,
  makeTextNode,
} from "../core/xml.js";

export {
  type XmlNode,
  parseXml,
  buildXml,
  tagOf,
  childrenOf,
  textOf,
  attrOf,
  findChild,
  findChildren,
  setChildren,
  makeTextNode,
} from "../core/xml.js";

export const HEADER_PART = "Contents/header.xml";
export const SECTION_RE = /^Contents\/section\d+\.xml$/;
export const MIMETYPE = "application/hwp+zip";

/** zip 파트 맵에서 섹션 XML 경로를 번호순으로 정렬해 반환. */
export function listSectionPaths(parts: Record<string, Uint8Array>): string[] {
  return Object.keys(parts)
    .filter((p) => SECTION_RE.test(p))
    .sort((a, b) => sectionIndex(a) - sectionIndex(b));
}

function sectionIndex(path: string): number {
  const m = path.match(/section(\d+)\.xml$/);
  return m ? Number(m[1]) : 0;
}

/** 섹션 XML 트리에서 루트 요소(hs:sec)를 찾는다. 선언/주석 노드는 건너뛴다. */
export function findSectionRoot(doc: XmlNode[]): XmlNode {
  const root =
    doc.find((n) => tagOf(n) === "hs:sec") ??
    doc.find((n) => {
      const t = tagOf(n);
      return t !== "" && t !== "#text" && !t.startsWith("?") && !t.startsWith("!");
    });
  if (!root) throw new Error("HWPX: 섹션 루트(hs:sec)를 찾을 수 없음");
  return root;
}

/** hp:p 문단 목록. */
export function findParagraphs(secRoot: XmlNode): XmlNode[] {
  return findChildren(childrenOf(secRoot), "hp:p");
}

/** hp:p 의 styleIDRef(스타일 참조 id). */
export function readParaStyleRef(p: XmlNode): string | undefined {
  return attrOf(p, "styleIDRef");
}

/** 노드의 속성 맵(:@)을 얕은 복사로 반환(없으면 빈 객체). */
export function attrsOf(node: XmlNode): Record<string, unknown> {
  const at = node[":@"] as Record<string, unknown> | undefined;
  return at ? { ...at } : {};
}

// ── 런 읽기 ────────────────────────────────────────────────────────────────

export interface HwpxRawRun {
  text: string;
  /** 텍스트 런이면 보존할 charPrIDRef(문자 서식 참조). */
  charPrRef?: string;
  /** 텍스트가 아닌 개체(표·그림·수식·secPr·ctrl…) 런: 원본 hp:run 전체 XML. */
  frozenXml?: string;
  /** frozen 런 라벨. */
  frozenLabel?: string;
}

/** hp:run 이 "텍스트만 담은 런"인지 — 자식이 모두 hp:t 이고 hp:t 안이 순수 텍스트일 때만. */
function isTextRun(run: XmlNode): boolean {
  for (const c of childrenOf(run)) {
    const t = tagOf(c);
    if (t === "#text") continue;
    if (t !== "hp:t") return false;
    for (const tc of childrenOf(c)) {
      if (tagOf(tc) !== "#text") return false; // hp:t 안에 마크업이 있으면 보수적으로 frozen
    }
  }
  return true;
}

function runText(run: XmlNode): string {
  let s = "";
  for (const c of childrenOf(run)) {
    if (tagOf(c) === "hp:t") {
      for (const tc of childrenOf(c)) {
        const tx = textOf(tc);
        if (tx !== undefined) s += tx;
      }
    }
  }
  return s;
}

/** 텍스트가 아닌 개체 런의 라벨 추정. */
function frozenRunLabel(run: XmlNode): string {
  for (const c of childrenOf(run)) {
    switch (tagOf(c)) {
      case "hp:tbl":
        return "[표]";
      case "hp:pic":
        return "[그림]";
      case "hp:equation":
        return "[수식]";
      case "hp:chart":
        return "[차트]";
      case "hp:secPr":
        return "[구역 설정]";
      case "hp:ctrl":
        return "[조판 부호]";
    }
  }
  return "[개체]";
}

/** hp:p → 런 목록. 텍스트 런은 charPrRef 보존, 개체 런은 통째 frozen. */
export function readRuns(p: XmlNode): HwpxRawRun[] {
  const runs: HwpxRawRun[] = [];
  for (const r of findChildren(childrenOf(p), "hp:run")) {
    if (isTextRun(r)) {
      runs.push({ text: runText(r), charPrRef: attrOf(r, "charPrIDRef") });
    } else {
      runs.push({ text: "", frozenXml: buildXml([r]), frozenLabel: frozenRunLabel(r) });
    }
  }
  return runs;
}

// ── 빌더 (decode) ──────────────────────────────────────────────────────────

/** 텍스트 런 → hp:run > hp:t. charPrIDRef 가 있으면 부착. */
export function makeTextRunNode(text: string, charPrRef: string | undefined): XmlNode {
  const node: XmlNode = { "hp:run": [{ "hp:t": [makeTextNode(text)] }] };
  if (charPrRef !== undefined) node[":@"] = { "@_charPrIDRef": charPrRef };
  return node;
}

/** frozen 런 → 원본 hp:run 그대로 복원. */
export function makeFrozenRunNode(frozenXml: string): XmlNode {
  const node = parseXml(frozenXml).find((n) => tagOf(n) === "hp:run");
  if (!node) throw new Error("HWPX: frozen 런 원본(hp:run)을 복원할 수 없음");
  return node;
}

/**
 * 보존된 hp:p 속성(JSON) + 런들 → hp:p 노드.
 * - 기존 문단: 원본 속성(paraPrIDRef·styleIDRef·id…)을 그대로 복원해 양식을 보존.
 * - 신규 문단(attrsJson 없음): paraPrIDRef=0 + 팔레트 styleIDRef 로 유효 속성을 부여.
 * 런이 비면 빈 텍스트 런 하나를 넣어 유효 문단을 보장한다(charPrIDRef=0).
 */
export function makeParagraphNode(
  attrsJson: string | undefined,
  runs: XmlNode[],
  defaults?: { styleIDRef?: string },
): XmlNode {
  const attrs: Record<string, unknown> = attrsJson
    ? (JSON.parse(attrsJson) as Record<string, unknown>)
    : { "@_paraPrIDRef": "0", "@_styleIDRef": defaults?.styleIDRef ?? "0" };
  const kids = runs.length > 0 ? runs : [makeTextRunNode("", "0")];
  const node: XmlNode = { "hp:p": kids };
  if (Object.keys(attrs).length > 0) node[":@"] = attrs;
  return node;
}
