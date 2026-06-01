import { describe, it, expect } from "vitest";
import { buildCfbModel, writeCfb, readCfb, isCfbBytes } from "../src/core/cfb.js";

function bytesOf(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

describe("CFB read/write 항등성", () => {
  const streams: Record<string, Uint8Array> = {
    FileHeader: bytesOf("HWP Document File".padEnd(32, "\0")),
    DocInfo: new Uint8Array(200).map((_, i) => i % 256), // 미니 스트림(작음)
    "BodyText/Section0": new Uint8Array(5000).map((_, i) => (i * 7) % 256), // 정규 스트림(큼)
    "BodyText/Section1": bytesOf("두 번째 섹션"),
    "BinData/BIN0001.png": new Uint8Array(8000).map((_, i) => (i * 13) % 256),
    PrvText: bytesOf(""), // 빈 스트림
  };

  it("writeCfb 결과는 CFB 시그니처를 갖는다", () => {
    const bytes = writeCfb(buildCfbModel(streams));
    expect(isCfbBytes(bytes)).toBe(true);
  });

  it("build → write → read 후 모든 스트림이 동일하다", () => {
    const bytes = writeCfb(buildCfbModel(streams));
    const r = readCfb(bytes);
    for (const [path, want] of Object.entries(streams)) {
      expect(Array.from(r.streams[path] ?? []), path).toEqual(Array.from(want));
    }
    // 경로 트리도 보존
    expect(r.pathOf.has("BodyText")).toBe(true);
    expect(r.pathOf.has("BodyText/Section0")).toBe(true);
    expect(r.pathOf.has("BinData/BIN0001.png")).toBe(true);
  });

  it("read → write → read 왕복이 안정적이다(스트림 내용 보존)", () => {
    const first = readCfb(writeCfb(buildCfbModel(streams)));
    const second = readCfb(writeCfb(first));
    for (const path of Object.keys(streams)) {
      expect(Array.from(second.streams[path] ?? []), path).toEqual(Array.from(first.streams[path] ?? []));
    }
  });

  it("스트림 내용만 바꿔도(크기 변화) 나머지는 보존된다", () => {
    const first = readCfb(writeCfb(buildCfbModel(streams)));
    const idx = first.pathOf.get("BodyText/Section0")!;
    first.data.set(idx, bytesOf("작아진 섹션 본문")); // 정규→미니로 크기 급감
    const r = readCfb(writeCfb(first));
    expect(new TextDecoder().decode(r.streams["BodyText/Section0"])).toBe("작아진 섹션 본문");
    expect(Array.from(r.streams["BinData/BIN0001.png"] ?? [])).toEqual(
      Array.from(streams["BinData/BIN0001.png"]!),
    );
  });
});
