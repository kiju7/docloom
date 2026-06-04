/**
 * 브라우저용 **통합 진입점** — 포맷에 따라 자동 분기한다.
 *   - hwp/hwpx → rhwp(WASM, 비동기). 호출측이 주입한 rhwpInit/HwpDocument 로 초기화·렌더·복원.
 *   - 그 외(docx/doc/pptx/xlsx/csv/html/txt/rtf…) → 코어(동기, WASM무관) encode/decode/previewHtml.
 *
 * 코어 자체는 WASM 에 의존하지 않는다(서버/Node 에서 무게·환경의존 회피). rhwp 는 hwp 문서를
 * 열 때만 lazy 로 초기화된다. 그래서 hwp 분기를 페이지마다 손으로 짤 필요 없이, namo.site·데모가
 * 같은 `open/restore` 를 공유한다.
 *
 * 사용:
 *   import rhwpInit, { HwpDocument } from ".../rhwp.js";
 *   import { createDocloomWeb } from ".../docloom-web.mjs";
 *   const dl = createDocloomWeb({ rhwpInit, HwpDocument, wasmUrl: ".../rhwp_bg.wasm" });
 *   const st = await dl.open(bytes, "문서.hwp");   // st.preview, st.editable, st.canRoundtrip
 *   // ... AI 가 st.editable 을 고쳐 editedHtml 생성 ...
 *   const { bytes: out, ext } = dl.restore(st, editedHtml);
 */
import {
  encode,
  decode,
  previewHtml,
  toPreviewHtml,
  adapterFor,
  formatFromFilename,
  hwpToTreePreviewHtml,
  hwpToEditableHtml,
  applyHwpEdits,
} from "./index.js";
import type { OfficeFormat } from "./index.js";
import type { Manifest } from "./model/manifest.js";

/** rhwp 의 HwpDocument 생성자(주입). exportHwpx 만 구조적으로 요구한다. */
export interface HwpDocumentCtor {
  new (bytes: Uint8Array): { exportHwpx(): Uint8Array };
}

export interface DocloomWebDeps {
  /** rhwp.js 기본 export(WASM 초기화). hwp 문서를 처음 열 때 1회 호출. */
  rhwpInit?: (opts?: { module_or_path?: string }) => Promise<unknown>;
  /** rhwp.js 의 HwpDocument 생성자. */
  HwpDocument?: HwpDocumentCtor;
  /** rhwp_bg.wasm 의 URL. 생략 시 rhwp.js 기본 위치(co-located) 사용. */
  wasmUrl?: string;
}

/** open() 결과 = 미리보기/편집 HTML + 복원에 필요한 내부 상태(restore 에 그대로 넘긴다). */
export interface DocloomSession {
  /** 판별된 포맷 id. */
  fmt: OfficeFormat | string;
  /** 자체완결 미리보기 HTML 페이지. */
  preview: string;
  /** AI 가 고칠 편집 채널 HTML. 왕복(복원) 불가 포맷이면 null. */
  editable: string | null;
  /** 편집→원본복원 가능 여부. */
  canRoundtrip: boolean;
  // 내부 상태(직접 건드리지 말 것)
  _doc?: { exportHwpx(): Uint8Array } | null;
  _manifest?: Manifest | null;
  _bytes?: Uint8Array;
  _name?: string;
}

const isHwp = (fmt: string): boolean => fmt === "hwp" || fmt === "hwpx";

export function createDocloomWeb(deps: DocloomWebDeps = {}) {
  let ready: Promise<unknown> | null = null;

  /** rhwp WASM 1회 초기화. 텍스트 폭 측정 콜백(브라우저 canvas)도 설치한다(이미 있으면 유지). */
  function ensureRhwp(): Promise<unknown> {
    if (!ready) {
      // DOM 타입(document/canvas)은 코어 tsconfig 에 없으므로 globalThis 경유 느슨한 접근.
      const g = globalThis as unknown as {
        measureTextWidth?: (font: string, text: string) => number;
        document?: { createElement(tag: string): { getContext(t: string): unknown } };
      };
      if (typeof g.measureTextWidth !== "function" && g.document) {
        let ctx: { font?: string; measureText(t: string): { width: number } } | null = null;
        let lastFont = "";
        g.measureTextWidth = (font: string, text: string): number => {
          if (!ctx) ctx = g.document!.createElement("canvas").getContext("2d") as typeof ctx;
          if (!ctx) return (text || "").length * 8;
          if (font !== lastFont) { ctx.font = font; lastFont = font; }
          return ctx.measureText(text || "").width;
        };
      }
      ready = deps.rhwpInit
        ? deps.rhwpInit(deps.wasmUrl ? { module_or_path: deps.wasmUrl } : undefined)
        : Promise.resolve();
    }
    return ready;
  }

  /** 문서 바이트 → 세션(미리보기 + 편집 HTML). hwp/hwpx 는 rhwp, 그 외는 코어로 분기. */
  async function open(bytes: Uint8Array, name = ""): Promise<DocloomSession> {
    let fmt = "?";
    let canRoundtrip = false;
    const hint = formatFromFilename(name);
    try { const ad = adapterFor(bytes, hint); fmt = ad.id; canRoundtrip = !!ad.supportsRoundTrip; } catch { /* 판별 실패 → ? */ }

    if (isHwp(fmt)) {
      if (!deps.HwpDocument) throw new Error("[docloom-web] hwp/hwpx 는 deps.HwpDocument(rhwp.js) 주입이 필요합니다.");
      await ensureRhwp();
      const doc = new deps.HwpDocument(bytes) as { exportHwpx(): Uint8Array };
      return {
        fmt,
        preview: hwpToTreePreviewHtml(doc as never, { title: name, rawBytes: bytes }),
        editable: hwpToEditableHtml(doc as never),
        canRoundtrip: true,
        _doc: doc,
        _manifest: null,
        _bytes: bytes,
        _name: name,
      };
    }

    const preview = previewHtml(bytes, { title: name, format: hint });
    if (!canRoundtrip) {
      return { fmt, preview, editable: null, canRoundtrip: false, _doc: null, _manifest: null, _bytes: bytes, _name: name };
    }
    const { html, manifest } = encode(bytes, { format: fmt as OfficeFormat });
    return { fmt, preview, editable: html, canRoundtrip: true, _doc: null, _manifest: manifest, _bytes: bytes, _name: name };
  }

  /**
   * 편집된 HTML → 갱신된 미리보기 HTML(수정 내용이 반영된 화면).
   * hwp 는 문서에 반영 후 트리 렌더(멱등), 그 외는 편집 본문을 미리보기 셸에 감싼다.
   */
  function previewEdited(session: DocloomSession, editedHtml: string): string {
    if (isHwp(session.fmt)) {
      if (!session._doc) throw new Error("[docloom-web] hwp 세션에 문서 인스턴스가 없습니다.");
      applyHwpEdits(session._doc as never, editedHtml);
      return hwpToTreePreviewHtml(session._doc as never, { title: session._name ?? "", rawBytes: session._bytes });
    }
    return toPreviewHtml(editedHtml, { title: session._name ?? "" });
  }

  /** 편집된 HTML → 원본 포맷 바이트. hwp 는 .hwpx 로 저장(exportHwp 불안정). */
  function restore(session: DocloomSession, editedHtml: string): { bytes: Uint8Array; ext: string } {
    if (isHwp(session.fmt)) {
      if (!session._doc) throw new Error("[docloom-web] hwp 세션에 문서 인스턴스가 없습니다(open 결과를 그대로 넘기세요).");
      applyHwpEdits(session._doc as never, editedHtml);
      return { bytes: session._doc.exportHwpx(), ext: "hwpx" };
    }
    if (!session._manifest) {
      throw new Error(`[docloom-web] '${session.fmt}' 는 편집 복원(왕복)을 지원하지 않습니다(미리보기 전용).`);
    }
    return { bytes: decode(editedHtml, session._manifest, { format: session.fmt as OfficeFormat }), ext: String(session.fmt) };
  }

  return { open, restore, previewEdited, ensureRhwp };
}
