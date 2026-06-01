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

createServer(async (req, res) => {
  try {
    if (req.method !== "POST") {
      res.statusCode = 404;
      return res.end("POST /preview | /encode | /decode");
    }
    const body = await readBody(req);
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
