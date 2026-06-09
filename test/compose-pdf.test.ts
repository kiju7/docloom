import { describe, it, expect } from "vitest";
import { zlibSync } from "fflate";
import { composeDocument, extractPdfModel } from "../src/index.js";
import type { LlmClient } from "../src/index.js";

const te = new TextEncoder();

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
function buildPdf(objs: { num: number; dict: string; stream?: Uint8Array }[]): Uint8Array {
  const parts: Uint8Array[] = [te.encode("%PDF-1.5\n")];
  for (const o of objs) {
    if (o.stream) {
      parts.push(te.encode(`${o.num} 0 obj ${o.dict} stream\n`));
      parts.push(o.stream);
      parts.push(te.encode(`\nendstream endobj\n`));
    } else parts.push(te.encode(`${o.num} 0 obj ${o.dict} endobj\n`));
  }
  parts.push(te.encode(`trailer << /Root 1 0 R >>\n%%EOF`));
  return concatBytes(parts);
}
function sourcePdf(): Uint8Array {
  const rgb = zlibSync(new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]));
  const content = te.encode(
    "BT /F1 14 Tf 1 0 0 1 40 120 Tm (Title) Tj ET " +
    "BT /F1 12 Tf 1 0 0 1 40 90 Tm (Body line) Tj ET",
  );
  return buildPdf([
    { num: 1, dict: "<< /Type /Catalog /Pages 2 0 R >>" },
    { num: 2, dict: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>" },
    { num: 3, dict: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>" },
    { num: 4, dict: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>" },
    { num: 5, dict: `<< /Length ${content.length} >>`, stream: content },
  ]);
}

function mockLlm(): LlmClient {
  return {
    async listModels() { return ["mock"]; },
    async chatJson({ user }) {
      const desc = JSON.parse(user.match(/\{[\s\S]*\}/)![0]) as { slots: { id: string }[] };
      const slots: Record<string, string> = {};
      for (const s of desc.slots) slots[s.id] = `FILL ${s.id}`;
      return { slots };
    },
  };
}

describe("compose: PDF 경로(PdfEditModel 채움)", () => {
  it("텍스트 조각을 슬롯으로 채워 새 PDF 로 재방출한다", async () => {
    const src = sourcePdf();
    const before = extractPdfModel(src).pages[0]!.items.map((i) => i.text).join("");
    expect(before).toContain("Title");

    const { bytes, meta } = await composeDocument(src, "자료", { llm: mockLlm(), model: "mock", format: "pdf" });
    expect([...bytes.subarray(0, 5)]).toEqual([...te.encode("%PDF-")]);
    expect(meta?.strategy).toBe("pdf");
    expect(meta?.filledCount).toBe(meta?.slotCount);

    const after = extractPdfModel(bytes).pages[0]!.items.map((i) => i.text).join("");
    expect(after).toContain("FILL");
    expect(after).not.toContain("Title");
  });
});
