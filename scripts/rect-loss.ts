import { readFileSync } from "node:fs";
import { loadRhwp } from "./rhwpNode.js";
const Ctor = (await loadRhwp())!;
function inspect(doc:any){ let rect=0,line=0,table=0,img=0,chars=0,tocPg=-1; const np=doc.pageCount();
  for(let pg=0;pg<np;pg++){ let t:any;try{t=JSON.parse(doc.getPageRenderTree(pg));}catch{continue;}
    (function w(n:any){ if(n.type==="Rect")rect++; if(n.type==="Line")line++; if(n.type==="Table")table++; if(n.type==="Image")img++;
      if(n.type==="TextRun")chars+=(n.text||"").length;
      if(n.type==="TextLine"){const x=(n.children||[]).filter((c:any)=>c.type==="TextRun").map((c:any)=>c.text||"").join(""); if(/차\s*례|목\s*차/.test(x)&&tocPg<0)tocPg=pg;}
      for(const c of (n.children||[]))w(c); })(t); }
  return {pages:np,rect,line,table,img,chars,tocPg}; }
const doc:any=new Ctor(new Uint8Array(readFileSync(process.argv[2]!)));
console.log("원본    :", JSON.stringify(inspect(doc)));
console.log("무편집복원:", JSON.stringify(inspect(new Ctor(doc.exportHwpx()))));
