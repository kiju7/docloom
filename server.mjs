// docloom HTTP 서버 — 다른 언어(Python·Go·Java·C++…)에서 호출하기 위한 얇은 한 겹.
// 의존성 없이 Node 내장 http 만 사용한다.
//   npm run build && node server.mjs   →  http://localhost:8080
import { createServer } from "node:http";
import { previewHtml, encode, decode } from "./dist/index.js";

const PORT = process.env.PORT || 8080;

// manifest 는 원본 바이트(Uint8Array)를 품고 있어 그대로 JSON 직렬화하면 깨진다.
// 바이너리를 base64 로 감싸 JSON 안전하게 만들고, decode 시 되돌린다.
// (클라이언트는 /encode 응답 JSON 을 그대로 /decode 에 돌려보내기만 하면 된다.)
const replacer = (_k, v) => (v instanceof Uint8Array ? { __u8__: Buffer.from(v).toString("base64") } : v);
const reviver = (_k, v) => (v && v.__u8__ !== undefined ? new Uint8Array(Buffer.from(v.__u8__, "base64")) : v);

const readBody = (req) =>
  new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });

// CORS: 브라우저(다른 오리진)에서 fetch 로 직접 호출할 수 있게 허용한다.
// ALLOW_ORIGIN 환경변수로 특정 도메인만 열 수 있고, 미설정 시 전체(*) 허용.
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || "*";

// ── AI 채팅 편집(/chat-edit) ────────────────────────────────────────────────
// 문서 바이트 + 사용자 지시 → encode 로 '편집채널 HTML' 을 뽑고, Claude 가 그 HTML 의
// 텍스트만 지시대로 고친 뒤 → decode 로 원본 포맷(양식 보존) 바이트로 되돌린다.
// API 키는 서버 환경변수(ANTHROPIC_API_KEY)에만 두어 공개 페이지에 노출되지 않는다.
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";

const CHAT_SYSTEM = [
  "너는 한국어 문서 편집 도우미다. 입력으로 '편집채널 HTML' 과 사용자 요청을 받는다.",
  "규칙:",
  "1) HTML 의 구조와 속성(class, data-pp, contenteditable, data-frozen 등)을 절대 바꾸지 마라.",
  "2) contenteditable=\"false\" 이거나 class 에 s-frozen 이 있는 노드의 내용은 건드리지 마라.",
  "3) 사용자가 요청한 텍스트 변경만 반영한다. 그 외 텍스트는 그대로 둔다.",
  "4) 출력은 반드시 아래 형태의 JSON 하나만. 다른 말/마크다운/코드펜스 금지.",
  '   {"reply":"사용자에게 한국어로 한두 문장","html":"수정된 전체 HTML, 또는 변경이 없으면 null"}',
  "5) 단순 질문(요약/설명)이라 문서 변경이 필요 없으면 html 을 null 로 두고 reply 만 채운다.",
].join("\n");

async function callClaude(systemText, messages, maxTokens = 8000) {
  if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY 가 설정되지 않았습니다(Render 환경변수에 추가하세요).");
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: maxTokens, system: systemText, messages }),
  });
  if (!r.ok) throw new Error(`Anthropic API ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const data = await r.json();
  return (data.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
}

// Claude 응답에서 JSON 한 덩이를 관대하게 추출(코드펜스/잡텍스트 방어).
function parseChatJson(text) {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  try { return JSON.parse(t); } catch {}
  const s = t.indexOf("{"), e = t.lastIndexOf("}");
  if (s >= 0 && e > s) { try { return JSON.parse(t.slice(s, e + 1)); } catch {} }
  return { reply: text, html: null };
}

createServer(async (req, res) => {
  // 모든 응답에 CORS 헤더를 붙인다.
  res.setHeader("Access-Control-Allow-Origin", ALLOW_ORIGIN);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Access-Control-Max-Age", "86400");
  // 프리플라이트(OPTIONS)는 본문 없이 204 로 바로 응답.
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }
  try {
    if (req.method !== "POST") {
      res.statusCode = 404;
      return res.end("POST /preview | /encode | /decode | /chat-edit");
    }
    const body = await readBody(req);
    if (req.url === "/chat-edit") {
      // 입력 JSON: { doc: base64, format?, instruction, history?: [{role, text}] }
      // 출력 JSON: { reply, doc: base64|null, changed }  (doc 는 변경됐을 때만 채움)
      const { doc, format, instruction, history = [] } = JSON.parse(body.toString("utf8"));
      const bytes = new Uint8Array(Buffer.from(doc, "base64"));
      const { html, manifest } = encode(bytes, format ? { format } : undefined);

      // 대화 맥락(과거 turn) + 현재 편집채널 HTML + 이번 지시.
      const convo = history.map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.text || "") }));
      convo.push({
        role: "user",
        content:
          `현재 편집채널 HTML:\n<<<HTML\n${html}\nHTML\n\n` +
          `사용자 요청: ${instruction}`,
      });

      const raw = await callClaude(CHAT_SYSTEM, convo);
      const out = parseChatJson(raw);

      let docB64 = null, changed = false;
      if (out.html && typeof out.html === "string" && out.html.trim() && out.html.trim() !== "null") {
        const newBytes = decode(out.html, manifest, format ? { format } : undefined);
        docB64 = Buffer.from(newBytes).toString("base64");
        changed = true;
      }
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ reply: out.reply || "처리했어요.", doc: docB64, changed }));
    }
    if (req.url === "/preview") {
      // 문서 바이트 → 미리보기 HTML
      res.setHeader("content-type", "text/html; charset=utf-8");
      return res.end(previewHtml(new Uint8Array(body)));
    }
    if (req.url === "/encode") {
      // 문서 바이트 → { html(편집용), manifest(복원 키트) }
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify(encode(new Uint8Array(body)), replacer));
    }
    if (req.url === "/decode") {
      // /encode 응답 JSON({ html, manifest }) → 양식 보존한 문서 바이트
      const { html, manifest } = JSON.parse(body.toString("utf8"), reviver);
      res.setHeader("content-type", "application/octet-stream");
      return res.end(Buffer.from(decode(html, manifest)));
    }
    res.statusCode = 404;
    res.end("unknown route");
  } catch (e) {
    res.statusCode = 500;
    res.end(String(e?.message || e));
  }
}).listen(PORT, () => console.log(`docloom listening on http://localhost:${PORT}`));
