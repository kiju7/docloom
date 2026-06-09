import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  composeDocument,
  extractDescriptor,
  applyFill,
  sanitizeInline,
  encode,
} from "../src/index.js";
import type { LlmClient } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const SAMPLE = join(here, "fixtures", "sample.docx");
const hasSample = existsSync(SAMPLE);
const loadSample = () => new Uint8Array(readFileSync(SAMPLE));

/** 양식 기술자를 읽어 모든 슬롯을 `채움-<id>` 로 채우는 가짜 LLM. */
function mockLlm(transform: (id: string, text: string) => string = (id) => `채움-${id}`): LlmClient {
  return {
    async listModels() {
      return ["mock"];
    },
    async chatJson({ user }) {
      // user 프롬프트에 들어있는 기술자 JSON 에서 슬롯 id 를 회수.
      const m = user.match(/\{[\s\S]*\}/);
      const desc = m ? (JSON.parse(m[0]) as { slots: { id: string; 현재텍스트: string }[] }) : { slots: [] };
      const slots: Record<string, string> = {};
      for (const s of desc.slots) slots[s.id] = transform(s.id, s.현재텍스트);
      return { slots };
    },
  };
}

describe("compose: sanitizeInline", () => {
  it("화이트리스트 인라인만 통과, 나머지는 이스케이프", () => {
    expect(sanitizeInline("일반 <b>굵게</b> <strong>OK</strong>")).toBe(
      "일반 &lt;b&gt;굵게&lt;/b&gt; <strong>OK</strong>",
    );
  });
  it("줄바꿈 → <br/>", () => {
    expect(sanitizeInline("줄1\n줄2")).toBe("줄1<br/>줄2");
  });
  it("스크립트 주입 무력화", () => {
    expect(sanitizeInline('<script>alert(1)</script>')).toBe(
      "&lt;script&gt;alert(1)&lt;/script&gt;",
    );
  });
});

describe.runIf(hasSample)("compose: docx 양식 채움 왕복", () => {
  it("extractDescriptor 가 채울 수 있는 블록을 슬롯으로 뽑는다", () => {
    const { html } = encode(loadSample()) as { html: string };
    const desc = extractDescriptor(html);
    expect(desc.fixed.length).toBeGreaterThan(0);
    expect(desc.fixed[0]!.id).toBe("s0");
    expect(["heading", "listItem", "body"]).toContain(desc.fixed[0]!.role);
  });

  it("applyFill 은 지정 슬롯만 바꾸고 나머지는 보존한다", () => {
    const { html } = encode(loadSample()) as { html: string };
    const before = extractDescriptor(html);
    const targetId = before.fixed[0]!.id;
    const edited = applyFill(html, { slots: { [targetId]: "바뀐텍스트" } });
    const after = extractDescriptor(edited);
    expect(after.fixed.length).toBe(before.fixed.length); // 구조 불변
    expect(after.fixed[0]!.text).toBe("바뀐텍스트");
    if (before.fixed.length > 1) {
      expect(after.fixed[1]!.text).toBe(before.fixed[1]!.text); // 나머지 보존
    }
  });

  it("composeDocument: 채운 뒤에도 같은 포맷으로 디코드되고 슬롯이 반영된다", async () => {
    const { bytes, meta } = await composeDocument(loadSample(), "테스트 자료", {
      llm: mockLlm(),
      model: "mock",
    });
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(meta?.filledCount).toBe(meta?.slotCount);
    // 결과 문서를 다시 encode → 슬롯이 채움값으로 바뀌었는지 확인(왕복 검증)
    const { html: html2 } = encode(bytes) as { html: string };
    const desc2 = extractDescriptor(html2);
    expect(desc2.fixed.length).toBeGreaterThan(0);
    expect(desc2.fixed.every((s) => s.text.startsWith("채움-"))).toBe(true);
  });

  it("부분 응답(일부 슬롯만)도 안전 — 빠진 슬롯은 원본 유지", async () => {
    const onlyFirst = (id: string) => (id === "s0" ? "오직s0" : "");
    const llm: LlmClient = {
      async listModels() {
        return ["mock"];
      },
      async chatJson({ user }) {
        const desc = JSON.parse(user.match(/\{[\s\S]*\}/)![0]) as { slots: { id: string }[] };
        const slots: Record<string, string> = {};
        const v = onlyFirst(desc.slots[0]!.id);
        if (v) slots[desc.slots[0]!.id] = v;
        return { slots };
      },
    };
    const { bytes } = await composeDocument(loadSample(), "자료", { llm, model: "mock" });
    const { html: html2 } = encode(bytes) as { html: string };
    const desc2 = extractDescriptor(html2);
    expect(desc2.fixed[0]!.text).toBe("오직s0");
  });
});
