/**
 * JsonFill 전략 — 기본값.
 *
 * 모델은 HTML 을 한 글자도 안 본다. 양식 기술자(슬롯 id·역할·현재텍스트)와 자료를 받아
 * { slots: { id: 새텍스트 } } JSON 만 돌려준다 → 구조/ data-* ref 가 모델을 통과하지 않으므로
 * 양식이 깨질 수 없다(로컬 모델 안전). 슬롯 값엔 화이트리스트 인라인(<strong> 등)만 허용.
 */
import type { FillStrategy, FillResult } from "../types.js";
import { extractDescriptor } from "../descriptor.js";
import { applyFill } from "../fill.js";
import { solicitFill } from "../llmFill.js";

export const jsonFill: FillStrategy = {
  name: "json",
  async fill({ editableHtml, material, llm, model }) {
    const descriptor = extractDescriptor(editableHtml);
    const result: FillResult = await solicitFill(descriptor, material, llm, model);
    const editedHtml = applyFill(editableHtml, result);
    return {
      editedHtml,
      meta: { strategy: "json", slotCount: descriptor.fixed.length, filledCount: Object.keys(result.slots).length },
    };
  },
};
