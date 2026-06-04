import { readFileSync } from "node:fs";
import { loadRhwp } from "./rhwpNode.js";
import { readZip } from "../src/core/zip.js";
const Ctor = (await loadRhwp())!;
const doc:any = new Ctor(new Uint8Array(readFileSync(process.argv[2]!)));
const hx = new TextDecoder().decode(readZip(doc.exportHwpx())["Contents/header.xml"]||new Uint8Array());
const show=(label:string,re:RegExp)=>{const m=hx.match(re);console.log(`\n── ${label} ──\n`,(m?m[0]:"(매칭 없음)").replace(/></g,">\n<").slice(0,600));};
show("첫 borderFill", /<hh:borderFill[\s\S]{0,500}?<\/hh:borderFill>/);
show("첫 paraPr", /<hh:paraPr\b[\s\S]{0,400}?(\/>|<\/hh:paraPr>)/);
// paraPr 에 borderFillIDRef 속성이 있나(있다면 값 분포)
const all=[...hx.matchAll(/<hh:paraPr\b([^>]*)>/g)];
const withBF=all.filter(m=>/borderFillIDRef/.test(m[1]!));
console.log(`\nparaPr 총 ${all.length}개, borderFillIDRef 속성 보유 ${withBF.length}개`);
console.log("borderFillIDRef 값 분포:", JSON.stringify(withBF.map(m=>m[1]!.match(/borderFillIDRef="(\d+)"/)?.[1]).reduce((a:any,v)=>{a[v!]=(a[v!]||0)+1;return a;},{})));
