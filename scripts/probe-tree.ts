/** 디버그: 누락 셀텍스트가 렌더트리(getPageRenderTree)의 TextRun 에 존재하는지 확인. */
import { readFileSync } from "node:fs";
import { loadRhwp } from "./rhwpNode.js";
const Ctor = (await loadRhwp())!;
const doc: any = new Ctor(new Uint8Array(readFileSync(process.argv[2]!)));
const probe = process.argv[3] ?? "문제해결을위한인공지능학습모델";
let treeText = "";
function walk(n: any) { if (n?.type === "TextRun" && n.text) treeText += n.text; for (const k of n?.children ?? []) walk(k); }
for (let i = 0; i < doc.pageCount(); i++) { try { walk(JSON.parse(doc.getPageRenderTree(i))); } catch {} }
treeText = treeText.replace(/\s+/g, "");
console.log(`treeTextLen=${treeText.length}  probe in tree? ${treeText.includes(probe.replace(/\s+/g,"")) ? "YES" : "NO"}`);
