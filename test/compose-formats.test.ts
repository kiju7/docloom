import { describe, it, expect } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { composeDocument, extractDescriptor, encode } from "../src/index.js";
import type { LlmClient } from "../src/index.js";

/** 모든 슬롯을 `채움-<id>` 로 채우는 가짜 LLM(기술자 JSON 에서 id 회수). */
function mockLlm(): LlmClient {
  return {
    async listModels() {
      return ["mock"];
    },
    async chatJson({ user }) {
      const desc = JSON.parse(user.match(/\{[\s\S]*\}/)![0]) as { slots: { id: string }[] };
      const slots: Record<string, string> = {};
      for (const s of desc.slots) slots[s.id] = `채움-${s.id}`;
      return { slots };
    },
  };
}

function pptx(): Uint8Array {
  return zipSync({
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>`,
    ),
    "ppt/presentation.xml": strToU8(`<p:presentation xmlns:p="x"/>`),
    "ppt/slides/slide1.xml": strToU8(
      `<p:sld xmlns:p="x" xmlns:a="y"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>안녕 슬라이드</a:t></a:r></a:p><a:p><a:r><a:t>두 번째 줄</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
    ),
  });
}

function xlsx(): Uint8Array {
  return zipSync({
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>`,
    ),
    "xl/workbook.xml": strToU8(`<workbook xmlns="x"><sheets><sheet name="매출"/></sheets></workbook>`),
    "xl/sharedStrings.xml": strToU8(`<sst xmlns="x"><si><t>이름</t></si><si><t>금액</t></si></sst>`),
    "xl/worksheets/sheet1.xml": strToU8(
      `<worksheet xmlns="x"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2"><v>100</v></c><c r="B2"><v>200</v></c></row></sheetData></worksheet>`,
    ),
  });
}

const csvBytes = () => new TextEncoder().encode("이름,금액\n홍길동,100\n임꺽정,200");
const mdBytes = () => new TextEncoder().encode("# 제목\n본문 문단입니다.\n\n- 항목1\n- 항목2");
const txtBytes = () => new TextEncoder().encode("첫 줄\n둘째 줄\n셋째 줄");

const CASES: { name: string; bytes: () => Uint8Array; format?: any; minSlots: number }[] = [
  { name: "pptx", bytes: pptx, minSlots: 2 },
  { name: "xlsx", bytes: xlsx, minSlots: 4 },
  { name: "csv", bytes: csvBytes, format: "csv", minSlots: 6 },
  { name: "md", bytes: mdBytes, format: "md", minSlots: 4 },
  { name: "txt", bytes: txtBytes, format: "txt", minSlots: 1 },
];

describe("compose: 멀티포맷 슬롯 추출 + 채움 왕복", () => {
  for (const c of CASES) {
    it(`${c.name}: 슬롯을 뽑고 채운 뒤 같은 포맷으로 디코드된다`, async () => {
      const input = c.bytes();
      const { html } = encode(input, { format: c.format }) as { html: string };
      const desc = extractDescriptor(html);
      expect(desc.fixed.length).toBeGreaterThanOrEqual(c.minSlots);

      const { bytes } = await composeDocument(input, "자료", {
        llm: mockLlm(),
        model: "mock",
        format: c.format,
      });
      expect(bytes.byteLength).toBeGreaterThan(0);

      // 결과를 다시 encode → 슬롯이 채움값으로 바뀌었는지(왕복 반영 검증)
      const { html: html2 } = encode(bytes, { format: c.format }) as { html: string };
      const desc2 = extractDescriptor(html2);
      const filled = desc2.fixed.filter((s) => s.text.startsWith("채움-")).length;
      expect(filled).toBeGreaterThan(0);
    });
  }
});
