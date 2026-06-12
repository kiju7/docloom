/**
 * hwp(.hwp) compose — rhwp(WASM) 경로.
 *
 * 순수 TS hwp 경로는 표를 frozen 으로만 보존해 표 셀을 LLM 이 못 채운다(텍스트가 엉뚱한 평문
 * 문단에 들어감). rhwp 는 표 셀·평문 문단을 앵커(data-hc/data-hcp/data-h)로 노출하므로,
 * 그 앵커를 슬롯으로 뽑아 채우고 다시 적용한다.
 *
 *   new HwpDocument(bytes) → hwpToEditableHtml(앵커 포함) → 슬롯 추출 → solicitFill(LLM)
 *   → 앵커 텍스트 교체 → applyHwpEdits → exportHwpx(편집된 바이트, HWPX)
 *
 * ⚠ rhwp 는 .hwp 저장(exportHwp) 버그로 **HWPX 로 내보낸다** — .hwp 입력이어도 결과는 .hwpx.
 * WASM 은 docloom 코어가 직접 의존하지 않고 호출측(서버)이 초기화한 HwpDocument 생성자를 받는다.
 */
import { parse } from "node-html-parser";
import { hwpToEditableHtml, applyHwpEdits, type RhwpDoc } from "../rhwp/hwpEdit.js";
import { solicitFill } from "./llmFill.js";
import type { LlmClient, Slot, TemplateDescriptor } from "./types.js";

export type HwpDocCtor = new (bytes: Uint8Array) => RhwpDoc & {
  exportHwpx(): Uint8Array;
  exportHwp?(): Uint8Array;
};

export interface HwpRhwpDeps {
  llm: LlmClient;
  model: string;
  /** 호출측(서버)이 초기화한 rhwp HwpDocument 생성자. */
  HwpDocument: HwpDocCtor;
}

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const norm = (s: string): string => s.replace(/​/g, "").replace(/\s+/g, " ").trim();

export async function composeHwpRhwp(
  bytes: Uint8Array,
  material: string,
  deps: HwpRhwpDeps,
): Promise<{ bytes: Uint8Array; meta: Record<string, unknown> }> {
  const doc = new deps.HwpDocument(bytes);
  const html = hwpToEditableHtml(doc);

  // 편집 앵커 수집: data-hc/data-hcp = 표 셀, data-h = 평문 문단.
  const root = parse(html);
  const anchors = root.querySelectorAll("[data-hc],[data-hcp],[data-h]");
  const all: Slot[] = anchors.map((el, i) => ({
    id: `s${i}`,
    role: el.getAttribute("data-h") != null ? "body" : "cell",
    text: norm(el.textContent ?? ""),
  }));

  // 양식 채움은 '빈칸 + 짧은 라벨'만 대상으로 한다. 긴 본문(안내문·지시문)은 LLM 에 보내지 않아
  // (1) 프롬프트 폭주로 모델이 빈 응답 내는 것을 막고 (2) 안내문을 그대로 보존한다.
  const FILL_MAX = 60; // 라벨/빈칸으로 볼 최대 글자수
  const send = all.filter((s) => s.text.length <= FILL_MAX);
  const descriptor: TemplateDescriptor = { fixed: send, groups: [] };

  const result = await solicitFill(descriptor, material, deps.llm, deps.model);

  // 채운 값을 앵커 div 텍스트로 교체(변경된 것만). rhwp 가 applyHwpEdits 에서 셀/문단에 반영.
  let filled = 0;
  anchors.forEach((el, i) => {
    const next = result.slots[`s${i}`];
    if (next === undefined) return;
    if (norm(next) === norm(el.textContent ?? "")) return;
    el.set_content(esc(next));
    filled++;
  });

  applyHwpEdits(doc, root.toString());

  // .hwp 네이티브 저장을 우선 시도(현재 rhwp 빌드에서 동작 확인). 결과가 CFB(D0 CF 11 E0)로
  // 유효하면 .hwp 로, 실패·무효(빈/비CFB)면 .hwpx 로 폴백한다.
  let out: Uint8Array | undefined;
  let output: "hwp" | "hwpx" = "hwpx";
  try {
    const h = doc.exportHwp?.();
    if (h && h.length > 8 && h[0] === 0xd0 && h[1] === 0xcf && h[2] === 0x11 && h[3] === 0xe0) {
      out = h;
      output = "hwp";
    }
  } catch {
    /* exportHwp 미지원·실패 → 아래 hwpx 폴백 */
  }
  if (!out) out = doc.exportHwpx();

  return {
    bytes: out,
    meta: { strategy: "hwp-rhwp", slotCount: all.length, fillTargets: send.length, filledCount: filled, output },
  };
}
