/**
 * PDF compose 경로 (HTML 왕복이 아닌 PdfEditModel 기반).
 *
 * PDF 는 의미적 문단이 아니라 좌표 글자조각(TextItem)이라 "양식 채움"이 best-effort 다:
 * 각 텍스트 조각을 슬롯으로 노출하고, 채운 텍스트로 조각을 갈아끼운 뒤 새 PDF 로 재방출한다.
 * (재방출 시 폰트는 비임베딩 — pdf 어댑터 한계. 좌표/이미지/벡터는 보존.)
 */
import { extractPdfModel, buildPdfFromModel } from "../formats/pdf.js";
import type { LlmClient, TemplateDescriptor, Slot } from "./types.js";
import { solicitFill } from "./llmFill.js";

/** PDF 바이트 + 자료 → 채운 PDF 바이트. */
export async function composePdf(
  bytes: Uint8Array,
  material: string,
  llm: LlmClient,
  model: string,
): Promise<{ bytes: Uint8Array; meta: Record<string, unknown> }> {
  const pdfModel = extractPdfModel(bytes);

  // 텍스트 있는 조각만 슬롯으로(좌표 순서 보존). id ↔ (page,item) 매핑 유지.
  const refs: { pi: number; ii: number }[] = [];
  const fixed: Slot[] = [];
  pdfModel.pages.forEach((pg, pi) => {
    pg.items.forEach((it, ii) => {
      if (it.text && it.text.trim()) {
        fixed.push({ id: `s${refs.length}`, role: "body", text: it.text });
        refs.push({ pi, ii });
      }
    });
  });

  const descriptor: TemplateDescriptor = { fixed, groups: [] };
  const result = await solicitFill(descriptor, material, llm, model);

  let filled = 0;
  refs.forEach((ref, idx) => {
    const next = result.slots[`s${idx}`];
    if (next !== undefined) {
      // PDF 조각은 평문만(좌표 기반 — 인라인 마크업 의미 없음). <br> 등 제거.
      pdfModel.pages[ref.pi]!.items[ref.ii]!.text = next.replace(/<[^>]+>/g, "");
      filled++;
    }
  });

  return {
    bytes: buildPdfFromModel(pdfModel),
    meta: { strategy: "pdf", slotCount: fixed.length, filledCount: filled },
  };
}
