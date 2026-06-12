/**
 * LLM 채움 요청 — 기술자(슬롯 목록)+자료 → { slots:{id:텍스트} } 검증된 결과.
 * HTML 전략(jsonFill)과 PDF 경로가 공유한다. 모델은 HTML 을 보지 않고 JSON 만 채운다.
 */
import { z } from "zod";
import type { LlmClient, FillResult, TemplateDescriptor } from "./types.js";

const FILL_SCHEMA = z.object({
  slots: z.record(z.string(), z.string()),
  groups: z.record(z.string(), z.array(z.string())).optional(),
});

export const FILL_SYSTEM = [
  "당신은 문서 양식 채움 엔진이다.",
  "주어진 '양식 기술자'는 채워야 할 슬롯 목록이다. 각 슬롯은 id, role(heading=제목, listItem=목록항목, body=본문, cell=표/셀), 현재텍스트를 가진다.",
  "일부 슬롯은 '반복그룹'으로 묶인다(같은 형태의 목록/문단 항목). 그룹은 자료 개수만큼 항목을 늘리거나 줄일 수 있다.",
  "사용자가 준 '자료'를, 단순히 그대로 복사하지 말고 각 슬롯의 역할(제목·일시·내용·요약 등)과 양식의 어조에 맞게 자연스럽고 완성된 문장·표현으로 다듬어 채워라(메모/단편은 그 칸에 어울리게 정리·완결).",
  "규칙:",
  '1) 출력은 오직 JSON: { "slots": { "<id>": "<새텍스트>" }, "groups": { "<groupId>": ["항목1","항목2", ...] } }. groups 는 없으면 생략. 설명·마크다운·코드펜스 금지.',
  "2) 반복그룹에 속한 슬롯 id 는 slots 에 넣지 말고 groups 의 배열로만 채워라(원하는 개수만큼).",
  "3) 그룹이 아닌 슬롯은 slots 에 넣어라. 비워둘 슬롯은 생략.",
  "4) 텍스트 안에는 <strong> <em> <u> <s> <br> 만 쓸 수 있다(셀 슬롯엔 평문 권장). 다른 태그·HTML 구조 금지.",
  "5) id/groupId 를 지어내지 말 것 — 주어진 것만 사용. 양식의 어조·언어를 따르라.",
  "6) 현재텍스트가 '항목명:' 처럼 라벨(말미가 콜론)로 끝나면, 그 라벨을 글자 그대로 유지하고 콜론 뒤에 값만 이어 써라. 예: 현재텍스트 '일시: ' → '일시: 2026-06-12'.",
  "7) 각 슬롯에는 그 슬롯의 라벨/역할에 맞는 값만 넣어라. 한 슬롯의 값을 다른 슬롯으로 옮기거나 라벨을 다른 항목명으로 바꾸지 말 것. 해당 값이 자료에 없으면 그 슬롯은 생략(원래 라벨 유지).",
  "8) 다듬기는 표현(문장 정리·완결·어투)에 한한다. 자료에 없는 사실(이름·날짜·숫자·기관·고유명사·결정·수치 등)을 새로 지어내지 말 것 — 사실은 오직 자료에 있는 것만 쓴다.",
  "9) 어떤 자료로도 뒷받침되지 않는 슬롯은 추측으로 메우지 말고 생략하라(빈칸/원래 라벨 유지). 확신이 없으면 비우는 쪽을 택한다.",
].join("\n");

function buildUser(descriptor: TemplateDescriptor, material: string): string {
  const groupMembers = new Set(descriptor.groups.flatMap((g) => g.memberIds));
  const slots = descriptor.fixed
    .filter((s) => !groupMembers.has(s.id))
    .map((s) => ({ id: s.id, role: s.role, 현재텍스트: s.text }));
  const groups = descriptor.groups.map((g) => ({
    groupId: g.groupId,
    role: g.unit[0]!.role,
    예시항목: g.memberIds.map((id) => descriptor.fixed.find((s) => s.id === id)?.text ?? ""),
  }));
  return [
    "## 양식 기술자",
    JSON.stringify({ slots, groups }, null, 2),
    "",
    "## 자료",
    material,
    "",
    "위 자료를 양식에 채워 JSON 으로만 반환하라.",
  ].join("\n");
}

/** 기술자+자료 → 검증된 FillResult. */
export async function solicitFill(
  descriptor: TemplateDescriptor,
  material: string,
  llm: LlmClient,
  model: string,
): Promise<FillResult> {
  const raw = await llm.chatJson({ model, system: FILL_SYSTEM, user: buildUser(descriptor, material) });
  const parsed = FILL_SCHEMA.safeParse(raw);
  if (!parsed.success) throw new Error(`[compose] 모델 응답이 스키마 불일치: ${parsed.error.message}`);
  return { slots: parsed.data.slots, groups: parsed.data.groups };
}
