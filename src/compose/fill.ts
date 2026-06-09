/**
 * FillResult → 편집된 HTML 되써넣기 (모든 포맷 공용).
 *
 * extractDescriptor 와 **같은 collectSlotNodes walk** 로 슬롯을 순회하므로 인덱스가 정확히
 * 대응한다. 슬롯 노드의 자식(텍스트)만 교체하고 — 노드 자신과 그 속성(data-pp/data-rp/
 * data-cell/data-run/data-piece)은 그대로 둔다 → 양식·복원 ref 보존.
 *
 *   - block 슬롯(p/h/li): 화이트리스트 인라인(<strong> 등) 허용. 단일 data-rp(런 서식)가 있으면
 *     새 텍스트를 그 span 으로 감싸 색·폰트도 유지. 파싱 실패 시 평문 폴백.
 *   - leaf 슬롯(셀·런·조각): 서식이 노드 자신이므로 평문 텍스트만 넣는다.
 *
 * 반복그룹(result.groups): 블록 단위를 자료 개수만큼 복제(같은 속성=서식 ref 유지)해 늘리거나,
 * 적으면 남는 예시 항목을 비운다.
 */
import { parseXml, buildXml, childrenOf, attrOf, setChildren } from "../core/xml.js";
import { makeTextNode } from "../core/xml.js";
import type { XmlNode } from "../core/xml.js";
import { collectSlotNodes, buildRepeatGroups } from "./descriptor.js";
import type { SlotNode } from "./descriptor.js";
import type { FillResult } from "./types.js";

const INLINE_TAGS = ["strong", "em", "u", "s"];

/** 모델 텍스트 → 안전한 인라인 HTML 조각(화이트리스트 외 전부 이스케이프). */
export function sanitizeInline(text: string): string {
  let s = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  s = s.replace(/\r?\n/g, "<br/>");
  for (const t of INLINE_TAGS) {
    s = s
      .replace(new RegExp(`&lt;${t}&gt;`, "g"), `<${t}>`)
      .replace(new RegExp(`&lt;/${t}&gt;`, "g"), `</${t}>`);
  }
  s = s.replace(/&lt;br\s*\/?&gt;/g, "<br/>");
  return s;
}

/** 블록 하위 첫 data-rp(런 서식 토큰) 값 — 지배적 런 서식 보존용. */
function dominantRp(node: XmlNode): string | undefined {
  for (const c of childrenOf(node)) {
    const rp = attrOf(c, "data-rp");
    if (rp !== undefined) return rp;
    const deep = dominantRp(c);
    if (deep !== undefined) return deep;
  }
  return undefined;
}

/** 슬롯 노드 자식을 새 텍스트로 교체(kind 별 규칙). */
function setSlotText(slot: SlotNode, text: string): void {
  if (slot.kind === "leaf") {
    setChildren(slot.node, [makeTextNode(text)]); // 서식=노드 자신 → 평문만
    return;
  }
  const inline = sanitizeInline(text);
  const rp = dominantRp(slot.node);
  const fragment = rp ? `<span data-rp="${rp}">${inline}</span>` : inline;
  let kids: XmlNode[];
  try {
    kids = childrenOf(parseXml(`<x>${fragment}</x>`)[0]!);
  } catch {
    kids = [makeTextNode(text)];
  }
  setChildren(slot.node, kids);
}

const idIdx = (id: string): number => Number(id.slice(1));

/** 반복그룹 채움: 단위 블록을 자료 개수만큼 복제/비우고 채운다. */
function applyGroup(slots: SlotNode[], group: { memberIds: string[]; role: SlotNode["role"] }, values: string[]): void {
  const members = group.memberIds.map((id) => slots[idIdx(id)]!).filter(Boolean);
  if (!members.length) return;
  const existing = members.length;
  const last = members[existing - 1]!;
  const parent = last.parent;
  const siblings = childrenOf(parent);

  // 기존 항목 채우기(있는 만큼)
  for (let k = 0; k < Math.min(values.length, existing); k++) setSlotText(members[k]!, values[k]!);
  // 모자라면 남는 예시 항목 비우기
  for (let k = values.length; k < existing; k++) setSlotText(members[k]!, "");
  // 넘치면 마지막 단위를 복제해 늘리기(같은 속성=서식 ref 유지 → 양식 상속)
  if (values.length > existing) {
    let after = siblings.indexOf(last.node);
    for (let k = existing; k < values.length; k++) {
      const clone = structuredClone(last.node) as XmlNode;
      const cloneSlot: SlotNode = { node: clone, kind: last.kind, role: last.role, parent, parentTag: last.parentTag };
      setSlotText(cloneSlot, values[k]!);
      siblings.splice(after + 1, 0, makeTextNode("\n"), clone);
      after += 2;
    }
  }
}

/**
 * 편집 HTML + 채움 결과 → 편집된 HTML.
 * 결과에 없는 슬롯은 원본 그대로 둔다(부분 채움 허용).
 */
export function applyFill(html: string, result: FillResult): string {
  const tree = parseXml(html);
  const slots = [...collectSlotNodes(tree)];

  // 1) 반복그룹 먼저(복제/삭감). 그룹이 다룬 멤버 id 는 fixed 에서 건너뛴다.
  const consumed = new Set<string>();
  if (result.groups) {
    const groups = buildRepeatGroups(slots);
    for (const g of groups) {
      const values = result.groups[g.groupId];
      if (!values) continue;
      applyGroup(slots, { memberIds: g.memberIds, role: g.unit[0]!.role }, values);
      for (const id of g.memberIds) consumed.add(id);
    }
  }

  // 2) 고정 슬롯 채우기(그룹이 처리한 멤버는 제외).
  for (const [id, text] of Object.entries(result.slots)) {
    if (consumed.has(id)) continue;
    const slot = slots[idIdx(id)];
    if (slot) setSlotText(slot, text);
  }

  return buildXml(tree);
}
