// docloom HTTP 서버 — 다른 언어(Python·Go·Java·C++…) 및 compose 페이지에서 호출하는 얇은 한 겹.
// 의존성 없이 Node 내장 http 만 사용한다.
//   npm run build && node server.mjs   →  http://localhost:8080
//
// compose(/compose) 는 서버측에서 Ollama 를 호출한다 → 브라우저는 문서+자료만 보내고,
// LLM 엔드포인트(OLLAMA_HOST)·모델(OLLAMA_MODEL)은 서버 환경변수로만 둔다(클라이언트 비노출).
//   OLLAMA_HOST  기본 http://localhost:11434   (이 서버에서 도달 가능한 Ollama)
//   OLLAMA_MODEL 미설정 시 /api/tags 첫 모델 자동 사용
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { join, normalize, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { previewHtml, encode, decode, composeDocument, createOllamaClient, formatFromFilename, structuredFill } from "./dist/index.js";

// .env 자동 로드(있으면). 의존성 0. 클라우드 배포(Render 등)·docker --env-file 은 process.env 로 직접
// 주입되므로 .env 없이도 동일하게 동작한다.
//   Node 20.12+ : 내장 process.loadEnvFile()
//   그 이전(예: 18): 내장이 없어 .env 를 직접 파싱(KEY=VALUE, # 주석/따옴표 처리, 기존 env 우선).
try {
  if (typeof process.loadEnvFile === "function") {
    process.loadEnvFile();
  } else {
    const text = readFileSync(new URL("./.env", import.meta.url), "utf8");
    for (const line of text.split("\n")) {
      if (/^\s*(#|$)/.test(line)) continue;
      const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      let val = m[2];
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
      if (!(m[1] in process.env)) process.env[m[1]] = val;
    }
  }
} catch { /* .env 가 없으면 무시 */ }

const PORT = process.env.PORT || 8080;
const OLLAMA_HOST = process.env.OLLAMA_HOST || "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "";

// GET 은 브라우저 데모(정적 파일)를 같은 포트에서 함께 서빙한다(POST API 와 동일 오리진).
// 데모는 100% 클라이언트 처리라 파일만 내려주면 된다.
const DEMO_DIR = fileURLToPath(new URL("./demo", import.meta.url));
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".json": "application/json",
  ".ico": "image/x-icon",
};

const replacer = (_k, v) => (v instanceof Uint8Array ? { __u8__: Buffer.from(v).toString("base64") } : v);
const reviver = (_k, v) => (v && v.__u8__ !== undefined ? new Uint8Array(Buffer.from(v.__u8__, "base64")) : v);

const readBody = (req) =>
  new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });

const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || "*";

/** 서버측 Ollama 로 모델 1개 확정(env 우선, 없으면 chat 가능 모델 자동 선택). */
async function pickModel(llm) {
  if (OLLAMA_MODEL) return OLLAMA_MODEL;
  // 자동 선택: /api/tags 의 capabilities 로 chat(completion) 가능한 모델만 후보로 거른다.
  // (nomic-embed-text 같은 임베딩 전용 모델이 잘못 선택돼 /api/chat 이 깨지는 footgun 방지)
  try {
    const res = await fetch(`${OLLAMA_HOST.replace(/\/+$/, "")}/api/tags`);
    if (res.ok) {
      const { models = [] } = await res.json();
      const chat = models.find((m) => (m.capabilities ?? []).includes("completion"));
      if (chat?.name) return chat.name;
    }
  } catch { /* capabilities 미지원 구버전 등 → 아래 listModels 폴백 */ }
  const models = await llm.listModels();
  if (!models.length) throw new Error("서버에 사용 가능한 Ollama 모델이 없습니다 (ollama pull <model>).");
  return models[0];
}

// rhwp(WASM) 1회 로드 — .hwp compose 의 표 셀 편집에 쓴다(없으면 순수 TS 경로로 폴백).
// 산출물은 demo/(런타임 이미지 포함) → vendor/rhwp/(개발) 순으로 찾는다.
let _hwpCtorPromise = null;
function loadHwpCtor() {
  if (_hwpCtorPromise) return _hwpCtorPromise;
  _hwpCtorPromise = (async () => {
    let dir = null;
    for (const d of ["./demo", "./vendor/rhwp"]) {
      if (existsSync(new URL(`${d}/rhwp.js`, import.meta.url))) { dir = d; break; }
    }
    if (!dir) throw new Error("rhwp 산출물(rhwp.js/rhwp_bg.wasm)을 찾을 수 없음");
    const rhwp = await import(new URL(`${dir}/rhwp.js`, import.meta.url).href);
    const wasm = await WebAssembly.compile(await readFile(new URL(`${dir}/rhwp_bg.wasm`, import.meta.url)));
    if (typeof globalThis.measureTextWidth !== "function") globalThis.measureTextWidth = (_f, t) => (t ? t.length * 10 : 0);
    await rhwp.default({ module_or_path: wasm });
    return rhwp.HwpDocument;
  })();
  return _hwpCtorPromise;
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
    if (req.method === "GET") {
      // 데모 정적 파일 제공. "/" → index.html, 경로 이탈(../)은 차단.
      const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
      const base = normalize(join(DEMO_DIR, urlPath === "/" ? "/index.html" : urlPath));
      if (!base.startsWith(DEMO_DIR)) {
        res.statusCode = 403;
        return res.end("forbidden");
      }
      // 확장자 없는 경로는 .html 도 후보로 본다(예: /compose → compose.html).
      const candidates = extname(base) ? [base] : [base, base + ".html"];
      for (const fp of candidates) {
        try {
          const data = await readFile(fp);
          res.setHeader("content-type", MIME[extname(fp)] || "application/octet-stream");
          return res.end(data);
        } catch { /* 다음 후보 시도 */ }
      }
      res.statusCode = 404;
      return res.end("not found");
    }
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
      // structuredFill: 빈 칸/값 칸에 항목(라벨·열헤더)을 붙여 정확 배치 + 기채움 값 교체.
      // (hwp 는 자체 rhwp 경로가 같은 구조화 채움을 쓰고, pdf 는 별도 경로라 strategy 무관.)
      const deps = { llm, model, format: fmt, strategy: structuredFill };
      // .hwp 는 rhwp 로 표 셀까지 채운다(결과는 HWPX). 로드 실패 시 순수 TS 경로로 폴백.
      if (fmt === "hwp") {
        try { deps.HwpDocument = await loadHwpCtor(); }
        catch (e) { console.error("[compose] rhwp 로드 실패 — 순수 TS 경로 사용:", e?.message ?? e); }
      }
      const { bytes: out, meta } = await composeDocument(bytes, material, deps);
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
