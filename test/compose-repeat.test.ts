import { describe, it, expect } from "vitest";
import { extractDescriptor, applyFill, encode } from "../src/index.js";

// 리스트 5항목 = 반복그룹 후보(연속 li ≥3)
const mdList = () =>
  new TextEncoder().encode("# 할 일\n\n- 항목1\n- 항목2\n- 항목3\n- 항목4\n- 항목5");

describe("compose: 반복영역 확장(블록 리스트)", () => {
  it("연속된 li 를 반복그룹으로 감지한다", () => {
    const { html } = encode(mdList(), { format: "md" }) as { html: string };
    const desc = extractDescriptor(html);
    expect(desc.groups.length).toBeGreaterThanOrEqual(1);
    const g = desc.groups[0]!;
    expect(g.sampleCount).toBe(5);
    expect(g.memberIds.length).toBe(5);
  });

  it("그룹을 자료 개수(7)만큼 복제해 늘린다", () => {
    const { html } = encode(mdList(), { format: "md" }) as { html: string };
    const desc = extractDescriptor(html);
    const g = desc.groups[0]!;
    const values = ["A", "B", "C", "D", "E", "F", "G"]; // 7개 > 예시 5개
    const edited = applyFill(html, { slots: {}, groups: { [g.groupId]: values } });
    const after = extractDescriptor(edited);
    const items = after.fixed.filter((s) => s.role === "listItem").map((s) => s.text);
    expect(items).toEqual(values); // 7개로 늘고 전부 채워짐
  });

  it("그룹을 자료 개수(2)만큼 줄이면 남는 예시는 비워진다", () => {
    const { html } = encode(mdList(), { format: "md" }) as { html: string };
    const desc = extractDescriptor(html);
    const g = desc.groups[0]!;
    const edited = applyFill(html, { slots: {}, groups: { [g.groupId]: ["X", "Y"] } });
    const after = extractDescriptor(edited);
    const items = after.fixed.filter((s) => s.role === "listItem").map((s) => s.text);
    expect(items.slice(0, 2)).toEqual(["X", "Y"]);
    expect(items.slice(2).every((t) => t === "")).toBe(true); // 나머지 비움
  });
});
