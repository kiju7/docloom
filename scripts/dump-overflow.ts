/** 디버그: 한 HWP 의 renderPageHtml 절대배치 요소를 바닥 기준으로 덤프(오버플로 진단). */
import { readFileSync } from "node:fs";
import { loadRhwp } from "./rhwpNode.js";

const path = process.argv[2] ?? "/Users/jd-kimkiju/Desktop/test_sample/hwp/1 상장 양식.hwp";
const pg = Number(process.argv[3] ?? "0");
const Ctor = (await loadRhwp())!;
const doc: any = new Ctor(new Uint8Array(readFileSync(path)));
const html: string = doc.renderPageHtml(pg);
const pageH = Number(html.match(/class="hwp-page"[^>]*?height:([\d.]+)px/)?.[1] ?? 0);
const pageW = Number(html.match(/class="hwp-page"[^>]*?width:([\d.]+)px/)?.[1] ?? 0);
console.log(`file=${path}\npage=${pg} pageW=${pageW} pageH=${pageH} htmlLen=${html.length}`);

interface It { top: number; h: number; tag: string; snippet: string }
const items: It[] = [];
for (const m of html.matchAll(/<(\w+)\b[^>]*style="([^"]*)"[^>]*>/g)) {
  const st = m[2]!;
  const top = Number(st.match(/top:(-?[\d.]+)px/)?.[1]);
  const h = Number(st.match(/height:([\d.]+)px/)?.[1]);
  if (Number.isFinite(top)) items.push({ top, h: Number.isFinite(h) ? h : 0, tag: m[1]!, snippet: m[0]!.slice(0, 120) });
}
items.sort((a, b) => b.top + b.h - (a.top + a.h));
console.log(`\n최하단 요소 (top+height 내림차순), page bottom=${pageH}:`);
for (const it of items.slice(0, 12)) {
  console.log(`  bottom=${(it.top + it.h).toFixed(0)} top=${it.top.toFixed(0)} h=${it.h.toFixed(0)} <${it.tag}> ${it.top + it.h > pageH + 1 ? "⚠OVER" : ""}`);
}
