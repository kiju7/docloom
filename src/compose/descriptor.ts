/**
 * 편집채널 HTML → TemplateDescriptor 추출 (모든 왕복 포맷 공용).
 *
 * decode 와 **같은 parseXml**(core/xml)로 HTML 을 걷는다 → 추출에 쓴 트리 구조가 decode 가
 * 되읽는 구조와 정확히 일치한다(왕복 안전). 슬롯 식별자는 슬롯 노드를 문서 순서로 걸으며
 * 매기는 인덱스(s0,s1,…) — 추출과 주입이 같은 collectSlotNodes 를 공유하므로 어긋날 수 없다.
 *
 * 슬롯 3종(포맷별 편집노드 형태를 하나의 DFS 로 흡수):
 *   - leaf(속성): [data-run](pptx)·[data-atom](ppt)·td[data-cell](xlsx/xls)·[data-piece](doc)
 *   - leaf(셀):   bare <td>(csv)
 *   - block:      <p>/<h1~6>/<li> 의 내용(docx·hwpx·md·html·txt·rtf). frozen(그림/도형) 품은
 *                 블록은 텍스트만 안전히 못 바꿔 제외.
 *
 * 반복그룹(표 행·리스트)은 buildRepeatGroups 로 감지하되, 실제 복제 주입은 fill 에서 한다.
 */
import { parseXml, tagOf, childrenOf, textOf, attrOf, deepText } from "../core/xml.js";
import type { XmlNode } from "../core/xml.js";
import type { Slot, RepeatGroup, TemplateDescriptor } from "./types.js";

const BLOCK_TAGS = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "li"]);
const CELL_TAGS = new Set(["td", "th"]);

export type SlotKind = "block" | "leaf";
export interface SlotNode {
  node: XmlNode;
  kind: SlotKind;
  role: Slot["role"];
  /** 노드를 담은 부모 요소(반복그룹 복제 시 형제 배열 splice 용). */
  parent: XmlNode;
  /** 부모의 태그(같은 컨테이너 안에서만 반복그룹으로 묶기 위함). */
  parentTag: string;
}

/** 편집 식별자(텍스트를 갈아끼울 leaf) 를 가진 노드인가. data-cell 은 읽기전용(data-ro) 제외. */
function isEditLeaf(node: XmlNode): boolean {
  if (attrOf(node, "data-cell") !== undefined) return attrOf(node, "data-ro") === undefined;
  return (
    attrOf(node, "data-run") !== undefined ||
    attrOf(node, "data-atom") !== undefined ||
    attrOf(node, "data-piece") !== undefined
  );
}

/** frozen(그림·도형) 자리표시자 노드 자신인가. */
function isFrozenSelf(node: XmlNode): boolean {
  return attrOf(node, "data-frozen-run") !== undefined || attrOf(node, "data-frozen") !== undefined;
}

/** 하위에 frozen 자리표시자가 있는가(블록 통째 교체 시 그림 유실 방지용). */
export function hasFrozen(node: XmlNode): boolean {
  if (isFrozenSelf(node)) return true;
  return childrenOf(node).some(hasFrozen);
}

function hasElementChild(node: XmlNode): boolean {
  return childrenOf(node).some((c) => tagOf(c) !== "#text");
}

/** 하위에 슬롯이 될 노드가 있는가(블록을 leaf 보다 우선 잡지 않도록). */
function containsSlot(node: XmlNode): boolean {
  for (const c of childrenOf(node)) {
    const t = tagOf(c);
    if (t === "#text") continue;
    if (isEditLeaf(c)) return true;
    if (BLOCK_TAGS.has(t)) return true;
    if (CELL_TAGS.has(t) && !hasElementChild(c)) return true;
    if (containsSlot(c)) return true;
  }
  return false;
}

function roleForBlock(tag: string): Slot["role"] {
  if (/^h[1-6]$/.test(tag)) return "heading";
  if (tag === "li") return "listItem";
  return "body";
}

function roleForLeaf(node: XmlNode): Slot["role"] {
  return attrOf(node, "data-cell") !== undefined ? "cell" : "body";
}

/**
 * 슬롯 노드를 문서 순서로 내놓는다(부모 동반). 추출과 주입이 **반드시 이 함수만** 써서 같은
 * 집합·순서를 보장한다(슬롯 인덱스 정합성의 단일 출처).
 */
export function* collectSlotNodes(nodes: XmlNode[], parent?: XmlNode): Generator<SlotNode> {
  const p = parent ?? { "#root": nodes };
  const pTag = parent ? tagOf(parent) : "#root";
  for (const node of nodes) {
    const tag = tagOf(node);
    if (tag === "#text") continue;
    if (isFrozenSelf(node)) continue;
    if (isEditLeaf(node)) {
      yield { node, kind: "leaf", role: roleForLeaf(node), parent: p, parentTag: pTag };
      continue;
    }
    if (CELL_TAGS.has(tag) && !hasElementChild(node)) {
      yield { node, kind: "leaf", role: "cell", parent: p, parentTag: pTag };
      continue;
    }
    if (BLOCK_TAGS.has(tag) && !hasFrozen(node) && !containsSlot(node)) {
      yield { node, kind: "block", role: roleForBlock(tag), parent: p, parentTag: pTag };
      continue;
    }
    yield* collectSlotNodes(childrenOf(node), node);
  }
}

/** 슬롯의 표시 텍스트. block 은 frozen 제외+<br>→\n, leaf 는 전체 텍스트. */
export function slotTextOf(s: SlotNode): string {
  if (s.kind === "leaf") return deepText(s.node);
  let out = "";
  const walk = (kids: XmlNode[]): void => {
    for (const c of kids) {
      const t = tagOf(c);
      if (t === "#text") out += textOf(c) ?? "";
      else if (t === "br") out += "\n";
      else if (isFrozenSelf(c)) continue;
      else walk(childrenOf(c));
    }
  };
  walk(childrenOf(s.node));
  return out;
}

/**
 * 반복그룹 감지: **같은 부모 아래 연속된 리스트 항목(li)** 묶음. 복제가 안전한 block 리스트만
 * 대상으로 한다(산문 본문 문단은 멋대로 늘어나면 곤란 → 제외, leaf 셀/런은 주소·id 의존 → 제외).
 * 3개 이상 연속부터 그룹으로 본다.
 */
export function buildRepeatGroups(slots: SlotNode[]): RepeatGroup[] {
  const groups: RepeatGroup[] = [];
  let i = 0;
  let gseq = 0;
  const sig = (s: SlotNode) => `${s.role}|${tagOf(s.node)}`;
  while (i < slots.length) {
    let j = i + 1;
    while (
      j < slots.length &&
      slots[j]!.kind === "block" &&
      slots[i]!.kind === "block" &&
      slots[j]!.parent === slots[i]!.parent && // 같은 컨테이너(형제)
      sig(slots[j]!) === sig(slots[i]!)
    )
      j++;
    const runLen = j - i;
    if (slots[i]!.kind === "block" && runLen >= 3 && slots[i]!.role === "listItem") {
      const memberIds = Array.from({ length: runLen }, (_, k) => `s${i + k}`);
      groups.push({
        groupId: `g${gseq++}`,
        unit: [{ slotId: `s${i}`, role: slots[i]!.role }],
        memberIds,
        sampleCount: runLen,
      });
    }
    i = j;
  }
  return groups;
}

/** 편집채널 HTML → 양식 기술자. */
export function extractDescriptor(html: string): TemplateDescriptor {
  const tree = parseXml(html);
  const slotNodes = [...collectSlotNodes(tree)];
  const fixed: Slot[] = slotNodes.map((s, i) => ({ id: `s${i}`, role: s.role, text: slotTextOf(s) }));
  const groups = buildRepeatGroups(slotNodes);
  return { fixed, groups };
}
