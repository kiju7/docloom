/**
 * Ollama 클라이언트(LlmClient 구현).
 *
 * 브라우저/Node 공용 — fetch 만 쓴다. 엔드포인트는 주입 가능(기본 http://localhost:11434).
 * HTTPS 페이지에서 http://localhost 호출은 mixed-content/PNA 로 막힐 수 있으므로, compose
 * 페이지는 로컬(http://localhost)에서 서빙하거나 사용자가 엔드포인트를 지정하게 한다.
 *
 * 속도/품질 관련 노트:
 *   - gpt-oss 등 추론(reasoning) 모델은 답(JSON) 전에 추론 토큰을 길게 생성한다 → 실제 소요시간의
 *     대부분이 추론이다. think 토큰도 num_ctx 를 소비하므로 추론을 줄이지 않는 한 num_ctx 는 함부로
 *     못 줄인다(둘은 커플링). 그래서 여기서는 품질 무손실 지렛대만 둔다:
 *       · think 채널 분리 — message.thinking 과 content 를 나눠 받아 content 가 순수 JSON 이 되게(파싱 안정성↑).
 *       · 스트리밍 — onProgress 로 진행을 흘려 체감 반응성↑(총 생성시간은 동일).
 *       · onPerf — Ollama 의 perf 메타(eval_count 등)를 노출해 어디서 시간이 새는지 계측.
 *     추론 강도 자체(think)는 호출측이 정한다(기본은 모델 기본값 유지).
 */
import type { LlmClient } from "../compose/types.js";

/** Ollama 추론 강도. boolean(on/off) 또는 gpt-oss 의 레벨 문자열. undefined 면 요청에서 생략(모델 기본). */
export type ThinkLevel = boolean | "low" | "medium" | "high";

/** /api/chat 응답의 성능 메타(나노초 단위 duration). 스트리밍/비스트리밍 공통. */
export interface OllamaPerf {
  /** 모델 로드(콜드 리로드/오프로드 시 큼). ns */
  loadDuration?: number;
  /** 프롬프트 평가(입력) 토큰 수 */
  promptEvalCount?: number;
  /** 프롬프트 평가 소요. ns */
  promptEvalDuration?: number;
  /** 생성(추론+답) 토큰 수 */
  evalCount?: number;
  /** 생성 소요. ns */
  evalDuration?: number;
  /** 전체 소요. ns */
  totalDuration?: number;
}

/** 스트리밍 진행 이벤트. */
export interface OllamaProgress {
  /** 지금까지 받은 청크 수(대략적 토큰 진행 지표). */
  tokens: number;
  /** 호출 시작부터 경과(ms). */
  elapsedMs: number;
  /** 추론(thinking) 채널 미리보기 — 마지막 일부. content(JSON)는 흘리지 않는다. */
  thinkingPreview: string;
}

export interface OllamaOptions {
  /** 기본 http://localhost:11434. 끝 슬래시는 알아서 정리. */
  endpoint?: string;
  /** fetch 주입(테스트/비표준 런타임용). 기본 globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** 추론 강도. 지정 시 요청에 think 를 명시(message.thinking 으로 분리 수신). 미지정이면 모델 기본. */
  think?: ThinkLevel;
  /** 지정 시 스트리밍으로 호출하고 청크마다 호출. 미지정이면 단발(non-streaming). */
  onProgress?: (ev: OllamaProgress) => void;
  /** 호출 1건이 끝날 때 perf 메타를 넘긴다(계측/로깅용). */
  onPerf?: (perf: OllamaPerf) => void;
}

/** 잘린 JSON 응답에서 완성된 "sN":"값" 쌍만 추출 → { slots }. 하나도 없으면 null. */
function salvageSlots(content: string): { slots: Record<string, string> } | null {
  const slots: Record<string, string> = {};
  const re = /"(s\d+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    try {
      slots[m[1]!] = JSON.parse(`"${m[2]}"`) as string;
    } catch {
      slots[m[1]!] = m[2]!;
    }
  }
  return Object.keys(slots).length > 0 ? { slots } : null;
}

/** Ollama 응답 객체(스트림 done 청크 또는 비스트림 본문)에서 perf 메타 추출. */
function pickPerf(o: Record<string, unknown>): OllamaPerf {
  const num = (k: string) => (typeof o[k] === "number" ? (o[k] as number) : undefined);
  return {
    loadDuration: num("load_duration"),
    promptEvalCount: num("prompt_eval_count"),
    promptEvalDuration: num("prompt_eval_duration"),
    evalCount: num("eval_count"),
    evalDuration: num("eval_duration"),
    totalDuration: num("total_duration"),
  };
}

interface ChatMessage {
  content?: string;
  thinking?: string;
}

/** 스트리밍 응답(NDJSON) 누적: content/thinking 을 모으고 청크마다 onProgress, done 청크에서 perf. */
async function readStream(
  res: Response,
  onProgress: ((ev: OllamaProgress) => void) | undefined,
  startedAt: number,
): Promise<{ content: string; perf: OllamaPerf }> {
  const body = res.body;
  if (!body) throw new Error("[ollama] 스트리밍 응답 본문이 없습니다.");
  const reader = (body as ReadableStream<Uint8Array>).getReader();
  const dec = new TextDecoder();
  let buf = "";
  let content = "";
  let thinking = "";
  let tokens = 0;
  let perf: OllamaPerf = {};
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(line);
      } catch {
        continue; // 부분 라인 등은 무시(완성 라인만 처리)
      }
      const msg = obj.message as ChatMessage | undefined;
      if (msg?.content) {
        content += msg.content;
        tokens++;
      }
      if (msg?.thinking) {
        thinking += msg.thinking;
        tokens++;
      }
      if (onProgress) onProgress({ tokens, elapsedMs: Date.now() - startedAt, thinkingPreview: thinking.slice(-160) });
      if (obj.done) perf = pickPerf(obj);
    }
  }
  return { content: content.trim(), perf };
}

export function createOllamaClient(opts: OllamaOptions = {}): LlmClient {
  const base = (opts.endpoint ?? "http://localhost:11434").replace(/\/+$/, "");
  const f = opts.fetchImpl ?? globalThis.fetch;
  if (typeof f !== "function") {
    throw new Error("[ollama] fetch 를 찾을 수 없음 — fetchImpl 을 주입하세요.");
  }
  const streaming = typeof opts.onProgress === "function";

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
      // reasoning 모델은 추론에 출력 토큰을 써서 content 가 비거나 JSON 이 잘릴 수 있다.
      //   - think 를 명시하면 추론은 message.thinking 으로 분리되어 content 는 순수 JSON 이 된다(파싱 안정성↑).
      //   - num_ctx 를 키워 추론+응답 자리를 확보(잘림 예방).
      //   - 그래도 잘리면 완성된 "sN":"값" 쌍만 살려 부분 채움이라도 반영(전부 실패 방지).
      //   - 그 외엔 temperature 올려 1회 재시도.
      let lastDetail = "";
      for (let attempt = 0; attempt < 2; attempt++) {
        const startedAt = Date.now();
        const res = await call(`/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model,
            stream: streaming,
            format: "json", // JSON 강제 디코딩
            keep_alive: "1h", // 64k 컨텍스트 모델을 계속 VRAM 에 둬 콜드 리로드(느림→502) 최소화
            ...(opts.think !== undefined ? { think: opts.think } : {}),
            options: { temperature: attempt === 0 ? 0 : 0.4, num_ctx: 65536 },
            messages: [
              { role: "system", content: system },
              { role: "user", content: user },
            ],
          }),
        });
        if (!res.ok) throw new Error(`[ollama] /api/chat 실패: ${res.status} ${await res.text().catch(() => "")}`);

        let content: string;
        let perf: OllamaPerf;
        if (streaming) {
          ({ content, perf } = await readStream(res, opts.onProgress, startedAt));
        } else {
          const data = (await res.json()) as Record<string, unknown>;
          content = ((data.message as ChatMessage | undefined)?.content ?? "").trim();
          perf = pickPerf(data);
        }
        opts.onPerf?.(perf);

        if (content) {
          try {
            return JSON.parse(content);
          } catch {
            const salvaged = salvageSlots(content);
            if (salvaged) return salvaged; // 잘린 JSON → 완성된 슬롯만 회수
            lastDetail = `JSON 파싱 실패: ${content.slice(0, 200)}`;
          }
        } else {
          lastDetail = "빈 응답(content 없음)";
        }
      }
      throw new Error(`[ollama] 모델이 JSON 응답을 주지 않음(재시도 후) — ${lastDetail}`);
    },
  };
}
