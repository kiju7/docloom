/**
 * Ollama 클라이언트(LlmClient 구현).
 *
 * 브라우저/Node 공용 — fetch 만 쓴다. 엔드포인트는 주입 가능(기본 http://localhost:11434).
 * HTTPS 페이지에서 http://localhost 호출은 mixed-content/PNA 로 막힐 수 있으므로, compose
 * 페이지는 로컬(http://localhost)에서 서빙하거나 사용자가 엔드포인트를 지정하게 한다.
 */
import type { LlmClient } from "../compose/types.js";

export interface OllamaOptions {
  /** 기본 http://localhost:11434. 끝 슬래시는 알아서 정리. */
  endpoint?: string;
  /** fetch 주입(테스트/비표준 런타임용). 기본 globalThis.fetch. */
  fetchImpl?: typeof fetch;
}

export function createOllamaClient(opts: OllamaOptions = {}): LlmClient {
  const base = (opts.endpoint ?? "http://localhost:11434").replace(/\/+$/, "");
  const f = opts.fetchImpl ?? globalThis.fetch;
  if (typeof f !== "function") {
    throw new Error("[ollama] fetch 를 찾을 수 없음 — fetchImpl 을 주입하세요.");
  }

  // 연결 거부 등 네트워크 오류를 "fetch failed" 대신 엔드포인트가 보이는 메시지로.
  const call = async (path: string, init?: RequestInit): Promise<Response> => {
    try {
      return await f(`${base}${path}`, init);
    } catch (e) {
      throw new Error(`Ollama 연결 실패 (${base}) — 서버에서 Ollama 가 실행 중인지 확인하세요. (${(e as Error)?.message ?? e})`);
    }
  };

  return {
    async listModels(): Promise<string[]> {
      const res = await call(`/api/tags`);
      if (!res.ok) throw new Error(`[ollama] /api/tags 실패: ${res.status}`);
      const data = (await res.json()) as { models?: { name?: string }[] };
      return (data.models ?? []).map((m) => m.name ?? "").filter(Boolean);
    },

    async chatJson({ model, system, user }): Promise<unknown> {
      const res = await call(`/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model,
          stream: false,
          format: "json", // JSON 강제 디코딩
          options: { temperature: 0 },
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
      });
      if (!res.ok) throw new Error(`[ollama] /api/chat 실패: ${res.status} ${await res.text().catch(() => "")}`);
      const data = (await res.json()) as { message?: { content?: string } };
      const content = data.message?.content ?? "";
      try {
        return JSON.parse(content);
      } catch {
        throw new Error(`[ollama] 모델이 JSON 이 아닌 응답을 반환: ${content.slice(0, 200)}`);
      }
    },
  };
}
