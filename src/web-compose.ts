/**
 * compose 페이지용 브라우저 진입점.
 *
 * 코어(encode/decode/previewHtml)는 동기·WASM무관 — docx/pptx/xlsx/csv/html/md/txt/rtf/hwpx
 * 등을 그대로 다룬다. (hwp 는 rhwp WASM 주입이 필요 — Stage 2 에서 데모처럼 연결.)
 * LLM 은 로컬 Ollama 직결(엔드포인트 지정 가능).
 *
 * 사용:
 *   import { createDocloomCompose } from ".../docloom-compose.mjs";
 *   const cx = createDocloomCompose();
 *   const preview = cx.previewHtml(bytes, name);          // 업로드 양식 미리보기
 *   const models = await cx.listModels(endpoint);         // 설치된 Ollama 모델
 *   const { bytes: out, preview } = await cx.run(bytes, 자료, { model, endpoint, name });
 */
// previewHtml = registry 의 바이트→완결 미리보기(주의: index 에는 문자열 body 용
// toPreviewHtml 도 있으니 반드시 바이트용 previewHtml 별칭을 쓴다).
import { previewHtml, formatFromFilename } from "./index.js";
import { composeDocument } from "./compose/index.js";
import { createOllamaClient } from "./llm/ollama.js";

export function createDocloomCompose() {
  return {
    /** 문서 바이트 → 자체완결 미리보기 HTML(맥 브라우저 셸 iframe 에 넣는다). */
    previewHtml(bytes: Uint8Array, name: string): string {
      return previewHtml(bytes, { title: name, format: formatFromFilename(name) });
    },

    /** Ollama 설치 모델 목록. */
    async listModels(endpoint?: string): Promise<string[]> {
      return createOllamaClient({ endpoint }).listModels();
    },

    /** 양식+자료 → 결과 바이트 + 결과 미리보기. */
    async run(
      bytes: Uint8Array,
      material: string,
      opts: { model: string; endpoint?: string; name: string },
    ): Promise<{ bytes: Uint8Array; preview: string; meta?: Record<string, unknown> }> {
      const llm = createOllamaClient({ endpoint: opts.endpoint });
      const fmt = formatFromFilename(opts.name);
      const { bytes: out, meta } = await composeDocument(bytes, material, { llm, model: opts.model, format: fmt });
      return { bytes: out, preview: previewHtml(out, { title: opts.name, format: fmt }), meta };
    },
  };
}
