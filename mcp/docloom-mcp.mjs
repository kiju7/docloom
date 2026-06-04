// docloom MCP 서버 — docloom 의 파싱/복원(encode·decode·preview)을 MCP 도구로 노출한다.
//   ⚠ 여기엔 LLM 이 없다. LLM 은 이 서버를 도구로 쓰는 "AI 호스트"(Claude Desktop/Code) 쪽에 있다.
//   docloom 본업(문서 ↔ 편집채널 HTML 무손실 왕복)만 도구로 제공 → 관심사 완전 분리.
//
// 흐름:  docloom_open(path)  → { handle, format, html }   (AI 가 html 을 보고 편집)
//        docloom_save(handle, html, out_path) → decode 로 양식 보존 복원 후 파일 저장
//        docloom_preview(path, out_path)      → 보기용 HTML 저장
//
// manifest(원본 바이트 포함, 큰 바이너리)는 모델에 넘기지 않고 서버 메모리에 핸들로 보관한다.
//
// 실행:  npm run build && node mcp/docloom-mcp.mjs   (stdio MCP 서버)
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { encode, decode, previewHtml } from "../dist/index.js";

// 열린 문서의 복원 키트(manifest)를 핸들(=절대경로)로 보관. AI 컨텍스트엔 안 들어간다.
const sessions = new Map(); // handle → { manifest, format }

const text = (t) => ({ content: [{ type: "text", text: t }] });
const fail = (t) => ({ content: [{ type: "text", text: t }], isError: true });

const server = new McpServer({ name: "docloom", version: "0.0.1" });

server.registerTool(
  "docloom_open",
  {
    title: "문서 열기(파싱)",
    description:
      "문서(.hwp/.hwpx/.docx/.csv/.txt 등)를 열어 '편집채널 HTML' 로 파싱한다. " +
      "반환된 html 의 텍스트를 수정한 뒤 docloom_save 로 넘기면 원본 양식을 보존한 채 복원된다. " +
      "구조/속성(class·data-pp·contenteditable·data-frozen)과 contenteditable=false(=s-frozen) 노드는 건드리지 말 것.",
    inputSchema: {
      path: z.string().describe("열 문서의 파일 경로"),
      format: z.string().optional().describe("포맷 강제 지정(보통 불필요, 자동 판별)"),
    },
  },
  async ({ path, format }) => {
    try {
      const handle = resolve(path);
      const bytes = new Uint8Array(readFileSync(handle));
      const { html, manifest } = encode(bytes, format ? { format } : undefined);
      sessions.set(handle, { manifest, format: manifest.format || format });
      return text(JSON.stringify({ handle, format: manifest.format || format, html }, null, 2));
    } catch (e) {
      return fail("열기 실패: " + (e?.message || e));
    }
  },
);

server.registerTool(
  "docloom_save",
  {
    title: "문서 저장(복원)",
    description:
      "docloom_open 으로 받은 handle 과, (선택적으로 수정한) 편집채널 html 을 원본 포맷으로 복원해 파일로 저장한다. " +
      "html 을 생략하면 원본 그대로 복원한다.",
    inputSchema: {
      handle: z.string().describe("docloom_open 이 반환한 handle"),
      html: z.string().describe("수정된 편집채널 HTML 전체"),
      out_path: z.string().describe("저장할 파일 경로"),
    },
  },
  async ({ handle, html, out_path }) => {
    try {
      const sess = sessions.get(resolve(handle));
      if (!sess) return fail(`알 수 없는 handle: ${handle} (먼저 docloom_open 으로 여세요)`);
      const bytes = decode(html, sess.manifest, sess.format ? { format: sess.format } : undefined);
      const outAbs = resolve(out_path);
      writeFileSync(outAbs, Buffer.from(bytes));
      return text(JSON.stringify({ saved: outAbs, bytes: bytes.length }, null, 2));
    } catch (e) {
      return fail("저장 실패: " + (e?.message || e));
    }
  },
);

server.registerTool(
  "docloom_preview",
  {
    title: "미리보기 HTML 생성",
    description: "문서를 보기용(읽기 전용) HTML 로 렌더해 파일로 저장한다. 편집/복원과는 무관한 표현용.",
    inputSchema: {
      path: z.string().describe("미리볼 문서 경로"),
      out_path: z.string().describe("저장할 .html 경로"),
      format: z.string().optional(),
    },
  },
  async ({ path, out_path, format }) => {
    try {
      const bytes = new Uint8Array(readFileSync(resolve(path)));
      const html = previewHtml(bytes, format ? { format } : undefined);
      const outAbs = resolve(out_path);
      writeFileSync(outAbs, html);
      return text(JSON.stringify({ saved: outAbs, bytes: html.length }, null, 2));
    } catch (e) {
      return fail("미리보기 실패: " + (e?.message || e));
    }
  },
);

await server.connect(new StdioServerTransport());
