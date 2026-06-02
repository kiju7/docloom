/** 디버그: getPageRenderTree 의 노드 타입+bbox 를 들여쓰기로 덤프(레이아웃 진단). */
import { readFileSync } from "node:fs";
import { loadRhwp } from "./rhwpNode.js";

const path = process.argv[2]!;
const pg = Number(process.argv[3] ?? "0");
const Ctor = (await loadRhwp())!;
const doc: any = new Ctor(new Uint8Array(readFileSync(path)));
const tree = JSON.parse(doc.getPageRenderTree(pg));
const pageH = Number(JSON.parse(doc.getPageDef(0)).height) / 7200 * 96;
console.log(`pageH≈${pageH.toFixed(0)}px`);

function walk(n: any, depth: number) {
  const b = n.bbox;
  const bb = b ? `[x=${b.x?.toFixed(0)} y=${b.y?.toFixed(0)} w=${b.w?.toFixed(0)} h=${b.h?.toFixed(0)}]` : "";
  const over = b && b.y > pageH ? " ⚠OVER" : "";
  const txt = n.text ? ` "${String(n.text).slice(0, 18)}"` : "";
  // 텍스트런은 너무 많으니 TextLine 까지만, TextRun 은 첫 1개 요약
  if (n.type !== "TextRun") console.log(`${"  ".repeat(depth)}${n.type} ${bb}${txt}${over}`);
  const kids = n.children ?? [];
  for (const k of kids) walk(k, depth + 1);
}
walk(tree, 0);
