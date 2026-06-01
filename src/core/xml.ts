/**
 * 포맷 무관 XML 프리미티브 (fast-xml-parser preserveOrder 래퍼).
 *
 * OOXML(docx/pptx/xlsx)은 모두 같은 XML 표현을 쓴다. 여기 있는 파서·셀렉터·빌더는
 * 네임스페이스(w:/a:/c:/r: …)에 의존하지 않는 "구문 수준" 유틸이라 모든 포맷이 공유한다.
 * 포맷 특화 로직(w:p 읽기 등)은 각 formats/<fmt> 가 이 위에 올린다.
 *
 * preserveOrder:true 모드의 노드 모양:
 *   { "<tag>": XmlNode[] , ":@"?: { "@_<attr>": value } }   (요소)
 *   { "#text": string }                                       (텍스트)
 */
import { XMLParser, XMLBuilder } from "fast-xml-parser";

export type XmlNode = Record<string, unknown>;

const PARSER_OPTS = {
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  preserveOrder: true,
  trimValues: false,
  processEntities: true,
} as const;

export function parseXml(xml: string): XmlNode[] {
  return new XMLParser(PARSER_OPTS).parse(xml) as XmlNode[];
}

export function buildXml(nodes: XmlNode[]): string {
  const builder = new XMLBuilder({ ...PARSER_OPTS, suppressEmptyNode: false });
  return builder.build(nodes);
}

// ── 셀렉터 ────────────────────────────────────────────────────────────────

/** 노드의 태그명 (텍스트 노드면 "#text"). */
export function tagOf(node: XmlNode): string {
  for (const k of Object.keys(node)) if (k !== ":@") return k;
  return "";
}

/** 요소의 자식 배열. 텍스트/빈 노드면 빈 배열. */
export function childrenOf(node: XmlNode): XmlNode[] {
  const v = node[tagOf(node)];
  return Array.isArray(v) ? (v as XmlNode[]) : [];
}

/** 텍스트 노드의 문자열 값 (아니면 undefined). */
export function textOf(node: XmlNode): string | undefined {
  const v = node["#text"];
  if (v === undefined) return undefined;
  return String(v);
}

/** 속성값 읽기. 예: attrOf(node, "w:val"). */
export function attrOf(node: XmlNode, name: string): string | undefined {
  const at = node[":@"] as Record<string, unknown> | undefined;
  if (!at) return undefined;
  const v = at[`@_${name}`];
  return v === undefined ? undefined : String(v);
}

export function findChild(children: XmlNode[], tag: string): XmlNode | undefined {
  return children.find((c) => tagOf(c) === tag);
}

export function findChildren(children: XmlNode[], tag: string): XmlNode[] {
  return children.filter((c) => tagOf(c) === tag);
}

export function isWhitespaceText(node: XmlNode): boolean {
  const t = textOf(node);
  return t !== undefined && t.trim() === "";
}

/** 요소의 자식 배열을 통째로 교체 (제자리 변경). */
export function setChildren(node: XmlNode, kids: XmlNode[]): void {
  node[tagOf(node)] = kids;
}

export function makeTextNode(s: string): XmlNode {
  return { "#text": s };
}

/** 트리 전체를 깊이우선 순회하며 처음 매칭되는 태그 노드를 찾는다. */
export function findDeep(nodes: XmlNode[], tag: string): XmlNode | undefined {
  for (const n of nodes) {
    if (tagOf(n) === tag) return n;
    const found = findDeep(childrenOf(n), tag);
    if (found) return found;
  }
  return undefined;
}

/** 트리 전체에서 매칭되는 모든 태그 노드를 모은다. */
export function collectDeep(nodes: XmlNode[], tag: string, out: XmlNode[] = []): XmlNode[] {
  for (const n of nodes) {
    if (tagOf(n) === tag) out.push(n);
    collectDeep(childrenOf(n), tag, out);
  }
  return out;
}

/** 노드 하위의 모든 텍스트를 이어붙여 반환(태그 무관). 미리보기 텍스트 추출용. */
export function deepText(node: XmlNode): string {
  const t = textOf(node);
  if (t !== undefined) return t;
  return childrenOf(node).map(deepText).join("");
}
