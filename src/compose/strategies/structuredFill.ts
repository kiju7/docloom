/**
 * StructuredFill 전략 — jsonFill 의 비교군(개선 후보).
 *
 * jsonFill 은 평평한 슬롯 목록({id, role, 현재텍스트})만 LLM 에 준다 → 어느 빈칸이 어느
 * 라벨에 속하는지 모델이 '순서로 추측'한다(복잡 양식에서 밀림).
 *
 * structuredFill 은 각 '빈칸'에 그 칸의 **항목(라벨)** 을 붙여 준다:
 *   - 표 값 셀  → 같은 행의 좌측 라벨 셀, 없으면 열 헤더
 *   - "항목: " 블록 → 콜론 앞 라벨
 * 그리고 **채울 칸(빈칸/콜론라벨)만** 보낸다(라벨 셀·긴 본문은 문맥으로만, 전송 제외).
 * id 순서는 collectSlotNodes(= applyFill 과 동일) 를 따르므로 적용은 jsonFill 과 같다.
 */
import { z } from "zod";
import type { FillStrategy, FillResult } from "../types.js";
import { applyFill } from "../fill.js";
import { collectSlotNodes, slotTextOf } from "../descriptor.js";
import { FILL_SYSTEM } from "../llmFill.js";
import { parseXml, tagOf, childrenOf, attrOf, deepText } from "../../core/xml.js";
import type { XmlNode } from "../../core/xml.js";

const FILL_SCHEMA = z.object({ slots: z.record(z.string(), z.string()) });

/** 트리에서 tag 노드 깊이우선 수집. */
function deepFind(nodes: XmlNode[], tag: string, out: XmlNode[] = []): XmlNode[] {
  for (const n of nodes) {
    if (tagOf(n) === tag) out.push(n);
    deepFind(childrenOf(n), tag, out);
  }
  return out;
}

/** 표 셀 노드 → 항목(라벨) 맵: 좌측 라벨 셀 우선, 없으면 열 헤더. */
function buildLabelMap(tree: XmlNode[]): Map<XmlNode, string> {
  const map = new Map<XmlNode, string>();
  for (const table of deepFind(tree, "table")) {
    const rows = deepFind([table], "tr");
    const grid = rows.map((tr) => {
      const out: { node: XmlNode; col: number; text: string }[] = [];
      let col = 0;
      for (const c of childrenOf(tr)) {
        const t = tagOf(c);
        if (t !== "td" && t !== "th") continue;
        const span = Number(attrOf(c, "colspan")) || 1;
        out.push({ node: c, col, text: deepText(c).trim() });
        col += span;
      }
      return out;
    });
    const headerByCol: Record<number, string> = {};
    if (grid[0]) for (const c of grid[0]) headerByCol[c.col] = c.text;
    grid.forEach((row, r) => {
      row.forEach((cell, idx) => {
        let label = idx > 0 ? row[idx - 1]!.text : "";
        if (!label && r > 0) label = headerByCol[cell.col] ?? "";
        if (label) map.set(cell.node, label);
      });
    });
  }
  return map;
}

/** "항목: " 형태면 콜론 앞 라벨, 아니면 "". */
function selfLabel(text: string): string {
  const m = text.match(/^(.{1,40}?)\s*[::]\s*$/);
  return m ? m[1]!.trim() : "";
}

/** 채울 칸인가: 빈 칸 또는 "라벨:" 로 끝나는 칸. (라벨 셀·기존 본문은 제외 → 문맥으로만) */
function isFillTarget(current: string): boolean {
  return current.trim() === "" || /[::]\s*$/.test(current);
}

function buildUser(
  fields: { id: string; label: string; role: string; current: string }[],
  material: string,
): string {
  const slots = fields.map((f) => ({
    id: f.id,
    항목: f.label || "(미상)",
    역할: f.role,
    현재값: f.current,
  }));
  return [
    "## 채울 양식 필드 (항목=칸의 라벨/머리글, 현재값=지금 내용; 현재값이 비었거나 '라벨:' 면 채울 칸)",
    JSON.stringify(slots, null, 1),
    "",
    "## 자료",
    material,
    "",
    "각 필드의 '항목'에 해당하는 값을 자료에서 찾아 채워라. 항목과 무관한 값을 넣지 말 것.",
    "현재값이 비어 있으면 **값만** 넣어라 — 항목명(라벨)은 옆 칸에 따로 있으니 값에 반복하지 말 것. (예: 항목 '회의명' → '2분기 로드맵', '회의명: …' 아님)",
    "현재값이 '일시: ' 처럼 콜론으로 끝나면 그 라벨을 그대로 유지하고 콜론 뒤에만 값을 이어 써라.",
    '출력은 { "slots": { "<id>": "<값>" } } JSON 만. 자료에 없는 항목은 생략.',
  ].join("\n");
}

export const structuredFill: FillStrategy = {
  name: "structured",
  async fill({ editableHtml, material, llm, model }) {
    const tree = parseXml(editableHtml);
    const slotNodes = [...collectSlotNodes(tree)];
    const labelOf = buildLabelMap(tree);

    const fields = slotNodes.map((sn, i) => {
      const current = slotTextOf(sn);
      return {
        id: `s${i}`,
        role: sn.role,
        current,
        label: labelOf.get(sn.node) || selfLabel(current),
      };
    });
    // 채울 칸만 전송(라벨 셀·긴 본문 제외 → 프롬프트 축소 + 오배치 방지). 라벨은 위 맵에서 이미 확보.
    const send = fields.filter((f) => isFillTarget(f.current));

    let slots: Record<string, string> = {};
    if (send.length > 0) {
      const raw = await llm.chatJson({ model, system: FILL_SYSTEM, user: buildUser(send, material) });
      const parsed = FILL_SCHEMA.safeParse(raw);
      if (parsed.success) slots = parsed.data.slots;
    }
    const result: FillResult = { slots };
    const editedHtml = applyFill(editableHtml, result);
    return {
      editedHtml,
      meta: {
        strategy: "structured",
        slotCount: fields.length,
        fillTargets: send.length,
        filledCount: Object.keys(slots).length,
      },
    };
  },
};
