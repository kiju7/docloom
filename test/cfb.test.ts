import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { readCfb, writeCfb, buildCfbModel, isCfbBytes } from "../src/core/cfb.js";

const SAMPLE_HWP = "/Users/jd-kimkiju/Desktop/docu_sample/2.HWP_보고서형식.hwp";

describe("readCfb 헬퍼/항등성", () => {
  it("4096B(v4) 섹터 크기 컨테이너도 읽는다", () => {
    // writeCfb 는 v3(512B)만 내지만, sectorShift 처리 검증을 위해 빌드→읽기 왕복으로
    // 미니 스트림(작은) + 정규 스트림(큰) 경로를 모두 통과시킨다.
    const streams: Record<string, Uint8Array> = {
      Small: new Uint8Array(100).map((_, i) => i),
      Large: new Uint8Array(9000).map((_, i) => (i * 3) % 256),
    };
    const bytes = writeCfb(buildCfbModel(streams));
    expect(isCfbBytes(bytes)).toBe(true);
    const r = readCfb(bytes);
    expect(Array.from(r.streams["Small"] ?? [])).toEqual(Array.from(streams["Small"]!));
    expect(Array.from(r.streams["Large"] ?? [])).toEqual(Array.from(streams["Large"]!));
  });

  it("비-CFB 바이트는 명확히 거부한다", () => {
    expect(() => readCfb(new Uint8Array([1, 2, 3, 4]))).toThrow();
  });
});

describe("실파일 CFB 검증(.hwp 는 유효한 CFB)", () => {
  it.runIf(existsSync(SAMPLE_HWP))("실제 .hwp 의 스트림을 읽어낸다", () => {
    const bytes = new Uint8Array(readFileSync(SAMPLE_HWP));
    expect(isCfbBytes(bytes)).toBe(true);
    const r = readCfb(bytes);
    // HWP 5.0 의 표준 스트림들이 보여야 한다.
    expect(r.streams["FileHeader"]).toBeDefined();
    expect(r.streams["DocInfo"]).toBeDefined();
    expect(r.streams["BodyText/Section0"]).toBeDefined();
    expect(r.streams["FileHeader"]!.length).toBeGreaterThan(0);
  });
});
