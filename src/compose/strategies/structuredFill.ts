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
import { collectSlotNodes, slotTextOf, buildRepeatGroups } from "../descriptor.js";
import { FILL_SYSTEM } from "../llmFill.js";
import { parseXml, buildXml, tagOf, childrenOf, attrOf, deepText, setChildren, makeTextNode } from "../../core/xml.js";
import type { XmlNode } from "../../core/xml.js";

const FILL_SCHEMA = z.object({
  slots: z.record(z.string(), z.string()).default({}),
  groups: z.record(z.string(), z.array(z.string())).optional(),
  tables: z.record(z.string(), z.array(z.array(z.string()))).optional(),
});

/** 트리에서 tag 노드 깊이우선 수집. */
function deepFind(nodes: XmlNode[], tag: string, out: XmlNode[] = []): XmlNode[] {
  for (const n of nodes) {
    if (tagOf(n) === tag) out.push(n);
    deepFind(childrenOf(n), tag, out);
  }
  return out;
}

/** 표 셀 노드 → 항목(라벨) 맵: 좌측 라벨 셀 우선, 없으면 열 헤더. */
interface CellInfo {
  /** 이 칸의 항목명(라벨/열 헤더). */
  label: string;
  /** 이 칸 자체가 라벨/헤더인가 → 채움 전송에서 제외(보존). */
  isLabel: boolean;
}

/**
 * 표 셀 노드 → 항목/라벨여부. 표 방향을 판별한다:
 *   - 헤더형(첫 행이 모두 차 있고 이후 행에 빈 칸): 첫 행=라벨, 이후 행=값(열 헤더가 항목).
 *   - 쌍형(라벨,값,라벨,값): 짝수열=라벨, 홀수열=값(좌측 라벨이 항목).
 * 라벨 칸은 isLabel=true → 채움 대상에서 빠져 보존된다(라벨-값 표의 라벨/헤더 행 오교체 방지).
 */
function buildLabelMap(tree: XmlNode[]): Map<XmlNode, CellInfo> {
  const map = new Map<XmlNode, CellInfo>();
  for (const table of deepFind(tree, "table")) {
    const grid = deepFind([table], "tr").map((tr) => {
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
    if (grid.length === 0) continue;
    const row0Filled = grid[0]!.length > 0 && grid[0]!.every((c) => c.text !== "");
    const laterEmpty = grid.slice(1).some((r) => r.some((c) => c.text === ""));
    if (grid.length >= 2 && row0Filled && laterEmpty) {
      const headerByCol: Record<number, string> = {};
      for (const c of grid[0]!) headerByCol[c.col] = c.text;
      grid.forEach((row, r) =>
        row.forEach((cell) =>
          map.set(cell.node, r === 0 ? { label: cell.text, isLabel: true } : { label: headerByCol[cell.col] ?? "", isLabel: false }),
        ),
      );
    } else {
      grid.forEach((row) =>
        row.forEach((cell, idx) => {
          if (cell.col % 2 === 0) map.set(cell.node, { label: cell.text, isLabel: true });
          else map.set(cell.node, { label: idx > 0 ? row[idx - 1]!.text : "", isLabel: false });
        }),
      );
    }
  }
  return map;
}

/** "항목: " 형태면 콜론 앞 라벨, 아니면 "". */
function selfLabel(text: string): string {
  const m = text.match(/^(.{1,40}?)\s*[::]\s*$/);
  return m ? m[1]!.trim() : "";
}

/** 채울 칸인가: 빈 칸 또는 "라벨:" 로 끝나는 칸. (라벨 셀·기존 본문은 제외 → 문맥으로만) */
export function isFillTarget(current: string): boolean {
  return current.trim() === "" || /[::]\s*$/.test(current);
}

/**
 * LLM 에 보낼 채움 필드인가. 빈 칸/'라벨:' 뿐 아니라, **항목(라벨)이 붙은 값 칸은 이미 채워져
 * 있어도 보낸다** → 자료로 기존 값을 교체할 수 있게(요구사항). 긴 본문(안내문)은 제외.
 */
export function isFillField(current: string, label: string): boolean {
  if (isFillTarget(current)) return true;
  return label !== "" && current.length <= 40; // 라벨 붙은 짧은 값 = 교체 대상
}

/** 반복 표(헤더형: 첫 행 머리글 + 데이터 행) 한 개. */
interface TableGroup {
  ref: string;
  headers: string[];
  /** 데이터 행 셀 노드(고정 슬롯 전송에서 제외용). */
  cellNodes: Set<XmlNode>;
}

/** 트리에서 반복 가능한 표(헤더형) 수집. 정보표(쌍형)는 제외. */
function buildTableGroups(tree: XmlNode[]): TableGroup[] {
  const out: TableGroup[] = [];
  for (const table of deepFind(tree, "table")) {
    const ref = attrOf(table, "data-table");
    if (ref === undefined) continue;
    const grid = deepFind([table], "tr").map((tr) =>
      childrenOf(tr)
        .filter((c) => tagOf(c) === "td" || tagOf(c) === "th")
        .map((td) => ({ node: td, text: deepText(td).trim() })),
    );
    if (grid.length < 2) continue;
    const row0Filled = grid[0]!.length > 0 && grid[0]!.every((c) => c.text !== "");
    const laterEmpty = grid.slice(1).some((r) => r.some((c) => c.text === ""));
    if (!(row0Filled && laterEmpty)) continue; // 헤더형만 반복 표
    const cellNodes = new Set<XmlNode>();
    grid.slice(1).forEach((row) => row.forEach((c) => cellNodes.add(c.node)));
    out.push({ ref, headers: grid[0]!.map((c) => c.text), cellNodes });
  }
  return out;
}

/** 표 행 확장: 응답 tables[ref]=행배열 만큼 마지막 데이터 행을 복제해 셀을 채운다. */
function expandTableRows(html: string, tables: Record<string, string[][]> | undefined): string {
  if (!tables || Object.keys(tables).length === 0) return html;
  const tree = parseXml(html);
  for (const table of deepFind(tree, "table")) {
    const ref = attrOf(table, "data-table");
    const rows = ref !== undefined ? tables[ref] : undefined;
    if (!rows || rows.length === 0) continue;
    const tbody = childrenOf(table).find((n) => tagOf(n) === "tbody") ?? table;
    const trs = childrenOf(tbody).filter((n) => tagOf(n) === "tr");
    if (trs.length < 2) continue;
    const headerTr = trs[0]!;
    const template = trs[trs.length - 1]!;
    const newRows = rows.map((vals) => {
      const clone = structuredClone(template) as XmlNode;
      const cells = childrenOf(clone).filter((c) => tagOf(c) === "td" || tagOf(c) === "th");
      cells.forEach((td, c) => setChildren(td, [makeTextNode(vals[c] ?? "")]));
      return clone;
    });
    setChildren(tbody, [headerTr, ...newRows]);
  }
  return buildXml(tree);
}

/** 구조화 프롬프트(항목/라벨 + 반복그룹 + 반복표 동반). hwp(rhwp) 경로도 공유한다. */
export function buildStructuredUser(
  fields: { id: string; label: string; role: string; current: string }[],
  material: string,
  groups: { groupId: string; role: string; 예시항목: string[] }[] = [],
  tables: { id: string; 열: string[] }[] = [],
): string {
  const slots = fields.map((f) => ({
    id: f.id,
    항목: f.label || "(미상)",
    역할: f.role,
    현재값: f.current,
  }));
  const lines = [
    "## 채울 양식 필드 (항목=칸의 라벨/머리글, 현재값=지금 내용; 현재값이 비었거나 '라벨:' 면 채울 칸)",
    JSON.stringify(slots, null, 1),
  ];
  if (groups.length > 0) {
    lines.push(
      "",
      "## 반복 목록(groups) — 자료 개수만큼 항목을 늘리거나 줄여 채운다(글머리/목록).",
      JSON.stringify(groups, null, 1),
    );
  }
  if (tables.length > 0) {
    lines.push(
      "",
      "## 반복 표(tables) — 각 표의 '열' 순서대로 행을 자료 개수만큼 만든다(행 자동 확장).",
      JSON.stringify(tables, null, 1),
    );
  }
  lines.push(
    "",
    "## 자료",
    material,
    "",
    "각 필드의 '항목'에 해당하는 값을 자료에서 찾아 채워라. 항목과 무관한 값을 넣지 말 것.",
    "**현재값에 이미 내용이 있어도, 자료에 그 항목의 값이 있으면 자료 값으로 교체하라.** 자료에 그 항목 값이 없으면 현재값을 그대로 두고 그 id 는 생략한다.",
    "현재값이 비어 있으면 **값만** 넣어라 — 항목명(라벨)은 옆 칸에 따로 있으니 값에 반복하지 말 것. (예: 항목 '회의명' → '2분기 로드맵', '회의명: …' 아님)",
    "현재값이 '일시: ' 처럼 콜론으로 끝나면 그 라벨을 그대로 유지하고 콜론 뒤에만 값을 이어 써라.",
    "현재값 자체가 항목명(라벨)인 칸은 건드리지 말 것(생략).",
  );
  if (tables.length > 0) {
    lines.push(
      "반복 표는 tables 의 각 id 에 행 배열을 넣어라 — 각 행은 '열' 순서의 문자열 배열. 자료 항목 수만큼 행을 만든다(번호 열이 있으면 1,2,3… 로 채움).",
    );
  }
  if (groups.length > 0) {
    lines.push("반복 목록은 groups 의 각 groupId 에 문자열 배열로 자료 개수만큼 채운다(많으면 늘리고 적으면 줄임).");
  }
  lines.push(
    `출력 JSON: { "slots": {…}${groups.length ? ', "groups": {…}' : ""}${tables.length ? ', "tables": { "<id>": [["행1열1","행1열2",…], …] }' : ""} }. 없는 건 생략. 설명·코드펜스 금지.`,
  );
  return lines.join("\n");
}

export const structuredFill: FillStrategy = {
  name: "structured",
  async fill({ editableHtml, material, llm, model }) {
    const tree = parseXml(editableHtml);
    const slotNodes = [...collectSlotNodes(tree)];
    const labelOf = buildLabelMap(tree);

    const fields = slotNodes.map((sn, i) => {
      const current = slotTextOf(sn);
      const info = labelOf.get(sn.node);
      return {
        id: `s${i}`,
        role: sn.role,
        current,
        label: info?.label || selfLabel(current),
        isLabel: info?.isLabel ?? false,
      };
    });

    // 반복 목록(연속 li) → 자료 개수만큼 확장.
    const repeatGroups = buildRepeatGroups(slotNodes);
    const groupMembers = new Set(repeatGroups.flatMap((g) => g.memberIds));
    const groupsForPrompt = repeatGroups.map((g) => ({
      groupId: g.groupId,
      role: g.unit[0]!.role,
      예시항목: g.memberIds.map((id) => fields[Number(id.slice(1))]?.current ?? ""),
    }));
    // 반복 표(헤더형) → 행 자동 확장. 데이터 행 셀은 고정 슬롯 전송에서 제외(표로 따로 채움).
    const tableGroups = buildTableGroups(tree);
    const tableCellNodes = new Set(tableGroups.flatMap((tg) => [...tg.cellNodes]));
    const tablesForPrompt = tableGroups.map((tg) => ({ id: tg.ref, 열: tg.headers }));

    // 채울 칸 전송: 빈 칸/'라벨:'/라벨 붙은 값(기채움 교체). 라벨·헤더 칸, 반복그룹/표 멤버, 긴 본문 제외.
    const send = fields.filter(
      (f, i) => !f.isLabel && !groupMembers.has(f.id) && !tableCellNodes.has(slotNodes[i]!.node) && isFillField(f.current, f.label),
    );

    let slots: Record<string, string> = {};
    let groups: Record<string, string[]> | undefined;
    let tables: Record<string, string[][]> | undefined;
    if (send.length > 0 || groupsForPrompt.length > 0 || tablesForPrompt.length > 0) {
      const raw = await llm.chatJson({
        model,
        system: FILL_SYSTEM,
        user: buildStructuredUser(send, material, groupsForPrompt, tablesForPrompt),
      });
      const parsed = FILL_SCHEMA.safeParse(raw);
      if (parsed.success) {
        slots = parsed.data.slots;
        groups = parsed.data.groups;
        tables = parsed.data.tables;
      }
    }
    const result: FillResult = { slots, ...(groups ? { groups } : {}) };
    let editedHtml = applyFill(editableHtml, result);
    editedHtml = expandTableRows(editedHtml, tables); // 표 행 확장(applyFill 이후 — 슬롯 id 안 흔듦)
    return {
      editedHtml,
      meta: {
        strategy: "structured",
        slotCount: fields.length,
        fillTargets: send.length,
        filledCount: Object.keys(slots).length,
        groups: groups ? Object.keys(groups).length : 0,
      },
    };
  },
};
