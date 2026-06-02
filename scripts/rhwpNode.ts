/**
 * Node 에서 rhwp WASM 을 초기화하는 공용 로더(테스트 + 검증 하베스트 공유).
 *
 * 로드 경로 우선순위:
 *   1) vendor/rhwp/           — 소스에서 직접 빌드해 벤더링한 산출물(엔진 수정 반영)
 *   2) node_modules/@rhwp/core — stock npm 0.7.13 폴백(벤더 산출물이 아직 없을 때)
 *
 * 이렇게 단일 파일로 경로를 캡슐화하면, rhwp 를 소스 빌드해 vendor/rhwp/ 로 떨구는 순간
 * 테스트와 하베스트가 자동으로 새 WASM 을 쓴다(다른 곳 수정 불필요).
 *
 * ⚠ Node 엔 canvas 가 없어 레이아웃 폭 측정 콜백을 length*10 스텁으로 채운다 — 텍스트/구조
 *   추출엔 영향 없지만 **픽셀 레이아웃은 가짜**다(픽셀 충실 검증은 브라우저 Canvas 에서만).
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import type { RhwpDoc } from "../src/rhwp/hwpEdit.js";

export type HwpDocCtor = new (b: Uint8Array) => RhwpDoc & {
  exportHwpx(): Uint8Array;
  exportHwp?(): Uint8Array;
  pageCount(): number;
};

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");

/** 산출물이 실제로 있는 첫 디렉터리(없으면 null). */
export function rhwpDir(): string | null {
  for (const d of [join(ROOT, "vendor", "rhwp"), join(ROOT, "node_modules", "@rhwp", "core")]) {
    if (existsSync(join(d, "rhwp_bg.wasm")) && existsSync(join(d, "rhwp.js"))) return d;
  }
  return null;
}

/** rhwp 빌드 식별자(vendor/rhwp/RHWP_BUILD.txt). 없으면 "(npm @rhwp/core)". */
export function rhwpBuildId(): string {
  const dir = rhwpDir();
  if (!dir) return "(none)";
  const tag = join(dir, "RHWP_BUILD.txt");
  return existsSync(tag) ? readFileSync(tag, "utf8").trim() : "(npm @rhwp/core)";
}

let ctor: HwpDocCtor | null = null;

/** WASM 을 1회 초기화하고 HwpDocument 생성자를 돌려준다(산출물 없으면 null). */
export async function loadRhwp(): Promise<HwpDocCtor | null> {
  if (ctor) return ctor;
  const dir = rhwpDir();
  if (!dir) return null;
  const rhwp: any = await import(pathToFileURL(join(dir, "rhwp.js")).href);
  const mod = await WebAssembly.compile(readFileSync(join(dir, "rhwp_bg.wasm")));
  if (typeof (globalThis as any).measureTextWidth !== "function") {
    (globalThis as any).measureTextWidth = (_font: string, text: string) => (text ? text.length * 10 : 0);
  }
  await rhwp.default({ module_or_path: mod });
  ctor = rhwp.HwpDocument as HwpDocCtor;
  return ctor;
}
