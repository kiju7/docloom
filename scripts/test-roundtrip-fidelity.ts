import { readFileSync } from "node:fs";
import { loadRhwp } from "./rhwpNode.js";
import { hwpToEditableHtml, applyHwpEdits } from "../src/rhwp/hwpEdit.js";
const Ctor = (await loadRhwp())!;
const F = process.argv[2]!;
function inspect(doc:any){
  let rect=0,line=0,toc=false;
  for(const pg of [0,1]){ let t:any; try{t=JSON.parse(doc.getPageRenderTree(pg));}catch{continue;}
    (function w(n:any){ if(n.type==="Rect")rect++; if(n.type==="Line")line++;
      if(n.type==="TextLine"){const x=(n.children||[]).filter((c:any)=>c.type==="TextRun").map((c:any)=>c.text||"").join(""); if(/차\s*례/.test(x))toc=true;}
      for(const c of (n.children||[]))w(c); })(t);
  }
  return {rect,line,toc};
}
const doc:any = new Ctor(new Uint8Array(readFileSync(F)));
const before = inspect(doc);
console.log("원본:", JSON.stringify(before));
// 편집 HTML 에서 평문 문단 하나 골라 텍스트 수정
const html = hwpToEditableHtml(doc);
const m = html.match(/<p data-h="([^"]+)">([^<]{6,})<\/p>/);
if(!m){console.log("편집할 평문 문단 없음");process.exit(0);}
const edited = html.replace(`>${m[2]}</p>`, `>${m[2]}★수정됨</p>`);
const n = applyHwpEdits(doc, edited);
const out = doc.exportHwpx();
console.log(`텍스트 수정 ${n}곳 → exportHwpx ${out.length}B`);
// 재로드 후 서식 보존 확인
const doc2:any = new Ctor(out);
const after = inspect(doc2);
console.log("복원물:", JSON.stringify(after));
const ok = after.rect>=before.rect*0.9 && after.line>=before.line*0.9 && after.toc===before.toc;
const editKept = hwpToEditableHtml(doc2).includes("★수정됨");
console.log(ok?"✅ 테두리(Rect/Line)·차례 보존됨":"❌ 서식 손실");
console.log(editKept?"✅ 텍스트 수정도 복원물에 반영됨":"❌ 수정 반영 안됨");
