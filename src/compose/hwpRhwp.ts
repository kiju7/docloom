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
import { parse, type HTMLElement } from "node-html-parser";
import { hwpToEditableHtml, applyHwpEdits, type RhwpDoc } from "../rhwp/hwpEdit.js";
import { FILL_SYSTEM } from "./llmFill.js";
import { buildStructuredUser, isFillField } from "./strategies/structuredFill.js";
import type { LlmClient } from "./types.js";

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
const selfLabel = (t: string): string => { const m = t.match(/^(.{1,40}?)\s*[::]\s*$/); return m ? m[1]!.trim() : ""; };

/**
 * rhwp 편집 HTML 의 표에서 각 셀 앵커 → {항목, 라벨여부}. 표 방향 판별(structuredFill 과 동일):
 * 헤더형=첫 행 라벨/이후 열헤더값, 쌍형=짝수열 라벨/홀수열 값. 라벨 칸은 isLabel=true(보존).
 */
function buildHwpLabelMap(root: HTMLElement): Map<HTMLElement, { label: string; isLabel: boolean }> {
  const map = new Map<HTMLElement, { label: string; isLabel: boolean }>();
  for (const table of root.querySelectorAll("table")) {
    const grid = table.querySelectorAll("tr").map((tr) => {
      const out: { anchor: HTMLElement | null; col: number; text: string }[] = [];
      let col = 0;
      for (const td of tr.querySelectorAll("td, th")) {
        const span = parseInt(td.getAttribute("colspan") || "1", 10) || 1;
        const anchor = td.querySelector("[data-hc],[data-hcp]");
        out.push({ anchor, col, text: norm((anchor ?? td).textContent ?? "") });
        col += span;
      }
      return out;
    });
    if (grid.length === 0) continue;
    const row0Filled = grid[0]!.length > 0 && grid[0]!.every((c) => c.text !== "");
    const laterEmpty = grid.slice(1).some((r) => r.some((c) => c.text === ""));
    const set = (cell: { anchor: HTMLElement | null }, info: { label: string; isLabel: boolean }) => {
      if (cell.anchor) map.set(cell.anchor, info);
    };
    if (grid.length >= 2 && row0Filled && laterEmpty) {
      const headerByCol: Record<number, string> = {};
      for (const c of grid[0]!) headerByCol[c.col] = c.text;
      grid.forEach((row, r) =>
        row.forEach((cell) =>
          set(cell, r === 0 ? { label: cell.text, isLabel: true } : { label: headerByCol[cell.col] ?? "", isLabel: false }),
        ),
      );
    } else {
      grid.forEach((row) =>
        row.forEach((cell, idx) =>
          set(cell, cell.col % 2 === 0 ? { label: cell.text, isLabel: true } : { label: idx > 0 ? row[idx - 1]!.text : "", isLabel: false }),
        ),
      );
    }
  }
  return map;
}

export async function composeHwpRhwp(
  bytes: Uint8Array,
  material: string,
  deps: HwpRhwpDeps,
): Promise<{ bytes: Uint8Array; meta: Record<string, unknown> }> {
  const doc = new deps.HwpDocument(bytes);
  const html = hwpToEditableHtml(doc);

  // 편집 앵커 수집: data-hc/data-hcp = 표 셀, data-h = 평문 문단.
  const root = parse(html);
  const labelMap = buildHwpLabelMap(root);
  const anchors = root.querySelectorAll("[data-hc],[data-hcp],[data-h]");
  const fields = anchors.map((el, i) => {
    const current = norm(el.textContent ?? "");
    const info = labelMap.get(el);
    return {
      id: `s${i}`,
      role: el.getAttribute("data-h") != null ? "body" : "cell",
      current,
      label: info?.label || selfLabel(current),
      isLabel: info?.isLabel ?? false,
    };
  });

  // 채울 칸만 LLM 에 보낸다(빈칸·'라벨:'·라벨 붙은 값=기채움 교체 포함). 라벨/헤더 칸·긴 안내문 제외.
  // 각 칸엔 항목(좌측 라벨/열 헤더)을 붙여 정확히 배치되게 한다(structuredFill 과 동일 원리).
  const send = fields.filter((f) => !f.isLabel && isFillField(f.current, f.label));
  let slots: Record<string, string> = {};
  if (send.length > 0) {
    const raw = (await deps.llm.chatJson({
      model: deps.model,
      system: FILL_SYSTEM,
      user: buildStructuredUser(send, material),
    })) as { slots?: Record<string, unknown> } | null;
    if (raw && raw.slots && typeof raw.slots === "object") {
      for (const [k, v] of Object.entries(raw.slots)) if (typeof v === "string") slots[k] = v;
    }
  }

  // 채운 값을 앵커 div 텍스트로 교체(변경된 것만). rhwp 가 applyHwpEdits 에서 셀/문단에 반영.
  let filled = 0;
  anchors.forEach((el, i) => {
    const next = slots[`s${i}`];
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
    meta: { strategy: "hwp-rhwp-structured", slotCount: fields.length, fillTargets: send.length, filledCount: filled, output },
  };
}
