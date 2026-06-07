/**
 * 코퍼스 파일 1개 → 사용자가 실제로 보는 미리보기 HTML(+ rhwp doc).
 *
 * ⚠ 반드시 데모/웹 진입점(createDocloomWeb)과 **동일한 렌더 경로**를 써야 오라클이 진짜로
 *   사용자가 보는 출력을 검사한다:
 *   - hwp / hwpx → hwpToTreePreviewHtml(doc, { rawBytes })
 *   - 그 외      → previewHtml(bytes, { format })   (레지스트리 adapterFor → toPreviewHtml)
 *
 * ⚠ Node 엔 canvas 가 없어 rhwp 레이아웃 폭은 스텁(rhwpNode). 텍스트/구조 추출엔 무관하나
 *   픽셀 위치는 가짜다 — 픽셀 충실은 Track 2(브라우저 + PDF 정답지)에서만 본다.
 */
import { readFileSync, statSync } from "node:fs";
import { extname, basename } from "node:path";
import { loadRhwp, type HwpDocCtor } from "../rhwpNode.js";
import { previewHtml, hwpToTreePreviewHtml } from "../../src/index.js";
import type { RhwpDoc } from "../../src/rhwp/hwpEdit.js";

export type RhwpDocFull = RhwpDoc & { exportHwpx(): Uint8Array; pageCount(): number };

export interface Rendered {
  file: string;
  name: string;
  ext: string;
  fmt: string;          // 렌더 경로(hwp/hwpx/docx/pptx/…)
  sizeMB: number;
  html: string;         // 미리보기 HTML(빈 문자열이면 실패)
  doc: RhwpDocFull | null;  // hwp/hwpx 일 때 rhwp 인스턴스(구조 오라클용)
  error?: string;
  ms: number;
}

/** 미리보기로 렌더해야 하는 문서 확장자(이미지 자산·정답 PDF 폴더는 제외). */
export const DOC_EXTS = new Set([
  "hwp", "hwpx", "docx", "doc", "pptx", "ppt", "xlsx", "xls",
  "pdf", "rtf", "html", "htm", "csv", "txt", "md",
]);

let ctor: HwpDocCtor | null | undefined;

/** 파일 바이트 → 미리보기 HTML(+ doc). 실패는 던지지 않고 error 필드로 돌려준다. */
export async function renderFile(file: string): Promise<Rendered> {
  const ext = extname(file).slice(1).toLowerCase();
  const name = basename(file);
  const sizeMB = Math.round((statSync(file).size / 1048576) * 10) / 10;
  const t0 = Date.now();
  const base: Rendered = { file, name, ext, fmt: ext, sizeMB, html: "", doc: null, ms: 0 };

  let bytes: Uint8Array;
  try { bytes = new Uint8Array(readFileSync(file)); }
  catch (e) { return { ...base, error: `read: ${msg(e)}`, ms: Date.now() - t0 }; }

  try {
    if (ext === "hwp" || ext === "hwpx") {
      if (ctor === undefined) ctor = await loadRhwp();
      if (!ctor) return { ...base, error: "rhwp WASM 없음(vendor/rhwp 빌드 필요)", ms: Date.now() - t0 };
      const doc = new ctor(bytes) as RhwpDocFull;
      const html = hwpToTreePreviewHtml(doc as never, { title: name, rawBytes: bytes });
      return { ...base, html, doc, ms: Date.now() - t0 };
    }
    const fmt = ext === "htm" ? "html" : ext;
    const html = previewHtml(bytes, { format: fmt as never, title: name } as never);
    return { ...base, fmt, html, ms: Date.now() - t0 };
  } catch (e) {
    return { ...base, error: `render: ${msg(e)}`, ms: Date.now() - t0 };
  }
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e).slice(0, 200);
}
