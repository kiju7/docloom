// docloom HTTP 서버 — 다른 언어(Python·Go·Java·C++…) 및 compose 페이지에서 호출하는 얇은 한 겹.
// 의존성 없이 Node 내장 http 만 사용한다.
//   npm run build && node server.mjs   →  http://localhost:8080
//
// compose(/compose) 는 서버측에서 Ollama 를 호출한다 → 브라우저는 문서+자료만 보내고,
// LLM 엔드포인트(OLLAMA_HOST)·모델(OLLAMA_MODEL)은 서버 환경변수로만 둔다(클라이언트 비노출).
//   OLLAMA_HOST  기본 http://localhost:11434   (이 서버에서 도달 가능한 Ollama)
//   OLLAMA_MODEL 미설정 시 /api/tags 첫 모델 자동 사용
import { createServer } from "node:http";
import { previewHtml, encode, decode, composeDocument, createOllamaClient, formatFromFilename } from "./dist/index.js";

// .env 자동 로드(있으면). Node 내장 — 의존성 0. 클라우드 배포(Render 등)는 대시보드 env 를 쓰면
// .env 없이도 동일하게 process.env 로 주입된다. (커스텀 경로: node --env-file=path server.mjs)
try { process.loadEnvFile(); } catch { /* .env 가 없으면 무시 */ }

const PORT = process.env.PORT || 8080;
const OLLAMA_HOST = process.env.OLLAMA_HOST || "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "";

const replacer = (_k, v) => (v instanceof Uint8Array ? { __u8__: Buffer.from(v).toString("base64") } : v);
const reviver = (_k, v) => (v && v.__u8__ !== undefined ? new Uint8Array(Buffer.from(v.__u8__, "base64")) : v);

const readBody = (req) =>
  new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });

const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || "*";

/** 서버측 Ollama 로 모델 1개 확정(env 우선, 없으면 첫 설치 모델). */
async function pickModel(llm) {
  if (OLLAMA_MODEL) return OLLAMA_MODEL;
  const models = await llm.listModels();
  if (!models.length) throw new Error("서버에 사용 가능한 Ollama 모델이 없습니다 (ollama pull <model>).");
  return models[0];
}

createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", ALLOW_ORIGIN);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }
  try {
    if (req.method !== "POST") {
      res.statusCode = 404;
      return res.end("POST /preview | /encode | /decode | /compose");
    }
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;
    const body = await readBody(req);

    if (path === "/preview") {
      // 문서 바이트 → 미리보기 HTML. ?name= 으로 포맷 힌트(평문 계열 정확 라우팅).
      const name = url.searchParams.get("name");
      const opts = name ? { title: name, format: formatFromFilename(name) } : undefined;
      res.setHeader("content-type", "text/html; charset=utf-8");
      return res.end(previewHtml(new Uint8Array(body), opts));
    }
    if (path === "/encode") {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify(encode(new Uint8Array(body)), replacer));
    }
    if (path === "/decode") {
      const { html, manifest } = JSON.parse(body.toString("utf8"), reviver);
      res.setHeader("content-type", "application/octet-stream");
      return res.end(Buffer.from(decode(html, manifest)));
    }
    if (path === "/compose") {
      // { doc(base64), material, name } → 서버가 Ollama 로 채움 → { doc(base64), preview, meta }
      const { doc, material, name } = JSON.parse(body.toString("utf8"));
      if (!doc || !material) throw new Error("doc, material 이 필요합니다.");
      const bytes = new Uint8Array(Buffer.from(doc, "base64"));
      const fmt = name ? formatFromFilename(name) : undefined;
      const llm = createOllamaClient({ endpoint: OLLAMA_HOST });
      const model = await pickModel(llm);
      const { bytes: out, meta } = await composeDocument(bytes, material, { llm, model, format: fmt });
      // 미리보기는 클라이언트가 렌더한다(특히 hwp 는 rhwp 라야 한글 정상). 서버는 결과 바이트만.
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ doc: Buffer.from(out).toString("base64"), meta: { ...meta, model } }));
    }
    res.statusCode = 404;
    res.end("unknown route");
  } catch (e) {
    res.statusCode = 500;
    res.end(String(e?.message || e));
  }
}).listen(PORT, () => console.log(`docloom listening on http://localhost:${PORT}`));
