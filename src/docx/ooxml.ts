/**
 * docx(word/document.xml) 특화 OOXML 헬퍼.
 *
 * 포맷 무관 XML 프리미티브(parseXml/buildXml/셀렉터/빌더)는 core/xml 에서 가져와
 * 그대로 재노출하고(기존 import 경로 호환), 여기서는 docx 특화 읽기/쓰기만 둔다.
 *
 * docx 본문 구조:
 *   w:document > w:body > [ w:p | w:tbl | ... , 마지막에 w:sectPr ]
 *   w:p   > w:pPr > w:pStyle@w:val = 스타일 id
 *   w:p   > w:r(런) > w:t = 텍스트,  w:r > w:rPr > (w:b|w:i|w:u|w:strike) = 직접서식
 */
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
  isWhitespaceText,
  setChildren,
  makeTextNode,
} from "../core/xml.js";

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
  isWhitespaceText,
  setChildren,
  makeTextNode,
} from "../core/xml.js";

export const DOCUMENT_PART = "word/document.xml";

// ── 본문 셀렉터 ──────────────────────────────────────────────────────────

export function findBody(doc: XmlNode[]): XmlNode {
  const docNode = doc.find((n) => tagOf(n) === "w:document");
  if (!docNode) throw new Error("OOXML: w:document 노드를 찾을 수 없음");
  const body = findChild(childrenOf(docNode), "w:body");
  if (!body) throw new Error("OOXML: w:body 노드를 찾을 수 없음");
  return body;
}

/** body 자식을 (공백 제외) 콘텐츠와 끝의 sectPr 로 분리. */
export function splitBodyChildren(body: XmlNode): { content: XmlNode[]; sectPr?: XmlNode } {
  const content: XmlNode[] = [];
  let sectPr: XmlNode | undefined;
  for (const n of childrenOf(body)) {
    if (isWhitespaceText(n)) continue;
    if (tagOf(n) === "w:sectPr") sectPr = n;
    else content.push(n);
  }
  return { content, sectPr };
}

export function readParagraphStyleId(p: XmlNode): string | undefined {
  const pPr = findChild(childrenOf(p), "w:pPr");
  if (!pPr) return undefined;
  const pStyle = findChild(childrenOf(pPr), "w:pStyle");
  return pStyle ? attrOf(pStyle, "w:val") : undefined;
}

/**
 * 문단의 w:pPr 에 pStyle 외 직접서식(정렬·들여쓰기·간격·번호·테두리 등)이 있으면
 * 그 w:pPr 전체를 XML 문자열로 반환. 보존할 직접서식이 없으면 undefined.
 * (decode 시 pStyle 만 현재 styleId 로 교체하고 나머지는 그대로 되살린다.)
 */
export function readParagraphDirectPPrXml(p: XmlNode): string | undefined {
  const pPr = findChild(childrenOf(p), "w:pPr");
  if (!pPr) return undefined;
  const hasDirect = childrenOf(pPr).some((c) => tagOf(c) !== "w:pStyle");
  return hasDirect ? buildXml([pPr]) : undefined;
}

export interface RawRun {
  text: string;
  marks: string[];
  /** 원본 w:rPr 의 비-마크 서식(색·크기·폰트·형광…)을 보존할 때의 XML 조각. */
  rPrXml?: string;
  /** 이미지·도형·OLE 등 텍스트가 아닌 런: 원본 w:r 전체 XML(통째로 보존). */
  frozenXml?: string;
  /** frozen 런의 라벨(예: "[그림]"). */
  frozenLabel?: string;
}

/** 텍스트가 아닌 임베드(이미지·도형·OLE)를 담는 런의 자식 태그. */
const EMBED_TAGS = new Set(["w:drawing", "w:pict", "w:object"]);

const MARK_TAGS: Record<string, string> = {
  "w:b": "bold",
  "w:i": "italic",
  "w:u": "underline",
  "w:strike": "strike",
};
const MARK_TAG_OF: Record<string, string> = {
  bold: "w:b",
  italic: "w:i",
  underline: "w:u",
  strike: "w:strike",
};

export function readRuns(p: XmlNode): RawRun[] {
  const runs: RawRun[] = [];
  for (const r of findChildren(childrenOf(p), "w:r")) {
    const rkids = childrenOf(r);

    // 이미지·도형·OLE 런 → 통째로 frozen 보존(텍스트 추출 안 함, LLM 엔 자리표시자만)
    const embed = rkids.find((c) => EMBED_TAGS.has(tagOf(c)));
    if (embed) {
      runs.push({
        text: "",
        marks: [],
        frozenXml: buildXml([r]),
        frozenLabel: tagOf(embed) === "w:object" ? "[개체]" : "[그림]",
      });
      continue;
    }

    const rPr = findChild(rkids, "w:rPr");
    const marks: string[] = [];
    let rPrXml: string | undefined;
    if (rPr) {
      const rPrKids = childrenOf(rPr);
      for (const m of rPrKids) {
        const mapped = MARK_TAGS[tagOf(m)];
        if (mapped) marks.push(mapped);
      }
      // 마크 외 직접서식(색·크기·폰트·형광…)이 있을 때만 원본 조각 보존
      if (rPrKids.some((c) => !(tagOf(c) in MARK_TAGS))) rPrXml = buildXml([rPr]);
    }
    let text = "";
    for (const child of rkids) {
      const t = tagOf(child);
      if (t === "w:t") {
        for (const tc of childrenOf(child)) {
          const tx = textOf(tc);
          if (tx !== undefined) text += tx;
        }
      } else if (t === "w:br" || t === "w:cr") {
        text += "\n"; // 줄바꿈 보존
      }
    }
    if (text.length > 0) runs.push(rPrXml ? { text, marks, rPrXml } : { text, marks });
  }
  return runs;
}

// ── 빌더 ──────────────────────────────────────────────────────────────────

function markNode(mark: string): XmlNode {
  const tag = MARK_TAG_OF[mark] ?? "w:strike";
  return { [tag]: [] };
}

/**
 * 보존된 w:rPr 조각 + 현재 마크 → 병합된 w:rPr 노드(없으면 undefined).
 *   - 비-마크 서식(색·크기·폰트·형광…)은 원본에서 그대로 유지
 *   - 마크(b/i/u/strike)는 현재 HTML 기준으로 재설정(편집으로 토글됐을 수 있음)
 * 마크 집합이 원본과 같으면 원본 조각을 그대로 써서 스키마 순서를 보존한다.
 */
function buildRunPropsNode(rPrXml: string | undefined, marks: string[]): XmlNode | undefined {
  const wanted = new Set(marks);
  if (rPrXml) {
    const parsed = parseXml(rPrXml);
    const rPr = parsed.find((n) => tagOf(n) === "w:rPr");
    if (rPr) {
      const kids = childrenOf(rPr);
      const original = new Set(kids.filter((c) => tagOf(c) in MARK_TAGS).map((c) => MARK_TAGS[tagOf(c)]!));
      const sameMarks = original.size === wanted.size && [...original].every((m) => wanted.has(m));
      if (sameMarks) return rPr; // 원본 그대로(순서 보존)
      // 마크가 바뀌었으면 마크 외 서식은 유지하고 마크만 교체(맨 앞에 삽입)
      const nonMark = kids.filter((c) => !(tagOf(c) in MARK_TAGS));
      const merged = [...marks.map(markNode), ...nonMark];
      return merged.length ? { "w:rPr": merged } : undefined;
    }
  }
  return marks.length ? { "w:rPr": marks.map(markNode) } : undefined;
}

/** RawRun → w:r 노드(보존된 rPr 병합). frozen 런이면 원본 w:r 을 그대로 복원. */
function makeRunNode(run: RawRun): XmlNode {
  if (run.frozenXml) {
    const wr = parseXml(run.frozenXml).find((n) => tagOf(n) === "w:r");
    if (wr) return wr;
  }
  const rkids: XmlNode[] = [];
  const rPr = buildRunPropsNode(run.rPrXml, run.marks);
  if (rPr) rkids.push(rPr);
  rkids.push({ "w:t": [makeTextNode(run.text)], ":@": { "@_xml:space": "preserve" } });
  return { "w:r": rkids };
}

/**
 * 보존된 w:pPr 조각(있으면) + styleId + 런들 → w:p 노드.
 * pStyle 은 항상 현재 styleId 로 강제 교체(맨 앞), 나머지 직접서식은 그대로 복원.
 * pPrXml 이 없으면 pStyle 만 있는 단순 문단.
 */
export function makeParagraphNodeFull(
  pPrXml: string | undefined,
  styleId: string,
  runs: RawRun[],
): XmlNode {
  let pPrNode: XmlNode = { "w:pPr": [{ "w:pStyle": [], ":@": { "@_w:val": styleId } }] };
  if (pPrXml) {
    const parsed = parseXml(pPrXml);
    const found = parsed.find((n) => tagOf(n) === "w:pPr");
    if (found) {
      // 기존 pStyle 제거 후 현재 styleId 로 맨 앞에 삽입(CT_PPr 에서 pStyle 이 선두)
      const kids = childrenOf(found).filter((c) => tagOf(c) !== "w:pStyle");
      kids.unshift({ "w:pStyle": [], ":@": { "@_w:val": styleId } });
      setChildren(found, kids);
      pPrNode = found;
    }
  }
  return { "w:p": [pPrNode, ...runs.map(makeRunNode)] };
}

/** styleId + 런들 → w:p 노드. heading/list 도 모두 w:p + pStyle 로 표현된다. */
export function makeParagraphNode(styleId: string, runs: RawRun[]): XmlNode {
  return makeParagraphNodeFull(undefined, styleId, runs);
}
