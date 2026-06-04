// docloom AI 편집 프록시 — docloom 과 "별개"인 얇은 서비스.
//   역할: 편집채널 HTML + 사용자 지시 → LLM 호출 → 수정된 HTML.  (그게 전부)
//   docloom 코어/서버와 무관. encode/decode 는 호출하는 페이지가 docloom 에 직접 한다.
//   LLM API 키는 이 서비스의 환경변수(ANTHROPIC_API_KEY)에만 둔다 → 공개 페이지에 노출 안 됨.
//
//   POST /edit  { html, instruction, history?:[{role,text}] }
//            →  { reply, html: 수정본|null, changed }
//
//   실행: ANTHROPIC_API_KEY=... node server.mjs   (의존성 없음, Node 18+ 전역 fetch)
import { createServer } from "node:http";

const PORT = process.env.PORT || 8090;
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || "*";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";

const SYSTEM = [
  "너는 한국어 문서 편집 도우미다. 입력으로 '편집채널 HTML' 과 사용자 요청을 받는다.",
  "규칙:",
  "1) HTML 의 구조와 속성(class, data-pp, contenteditable, data-frozen 등)을 절대 바꾸지 마라.",
  '2) contenteditable="false" 이거나 class 에 s-frozen 이 있는 노드의 내용은 건드리지 마라.',
  "3) 사용자가 요청한 텍스트 변경만 반영한다. 그 외 텍스트/태그는 그대로 둔다.",
  "4) 출력은 반드시 아래 JSON 하나만. 다른 말/마크다운/코드펜스 금지.",
  '   {"reply":"사용자에게 한국어로 한두 문장","html":"수정된 전체 HTML, 또는 변경이 없으면 null"}',
  "5) 단순 질문(요약/설명 등 문서 변경이 불필요)이면 html 을 null 로 두고 reply 만 채운다.",
].join("\n");

const readBody = (req) =>
  new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });

async function callClaude(messages, maxTokens = 8000) {
  if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY 가 설정되지 않았습니다(이 서비스의 환경변수에 추가).");
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: maxTokens, system: SYSTEM, messages }),
  });
  if (!r.ok) throw new Error(`Anthropic API ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const data = await r.json();
  return (data.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
}

// LLM 응답에서 JSON 한 덩이를 관대하게 추출(코드펜스/잡텍스트 방어).
function parseJson(text) {
  let t = (text || "").trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  try { return JSON.parse(t); } catch {}
  const s = t.indexOf("{"), e = t.lastIndexOf("}");
  if (s >= 0 && e > s) { try { return JSON.parse(t.slice(s, e + 1)); } catch {} }
  return { reply: text, html: null };
}

createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", ALLOW_ORIGIN);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }
  try {
    if (req.method !== "POST" || req.url !== "/edit") {
      res.statusCode = 404;
      return res.end("POST /edit  { html, instruction, history? }");
    }
    const { html, instruction, history = [] } = JSON.parse((await readBody(req)).toString("utf8"));
    if (!html || !instruction) { res.statusCode = 400; return res.end("html, instruction 필수"); }

    const convo = history.map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.text || "") }));
    convo.push({ role: "user", content: `편집채널 HTML:\n<<<HTML\n${html}\nHTML\n\n사용자 요청: ${instruction}` });

    const out = parseJson(await callClaude(convo));
    const changed = !!(out.html && typeof out.html === "string" && out.html.trim() && out.html.trim() !== "null");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ reply: out.reply || "처리했어요.", html: changed ? out.html : null, changed }));
  } catch (e) {
    res.statusCode = 500;
    res.end(String(e?.message || e));
  }
}).listen(PORT, () => console.log(`docloom ai-proxy listening on http://localhost:${PORT}`));
