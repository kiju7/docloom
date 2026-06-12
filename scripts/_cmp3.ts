import { readFileSync, writeFileSync } from "node:fs";
import puppeteer from "puppeteer-core";
import { loadRhwp } from "./rhwpNode.js";
const HwpDocument=(await loadRhwp())!;
const doc:any=new HwpDocument(new Uint8Array(readFileSync(process.argv[2]!)));
// rhwp native renderPageHtml for page 1 (the multi-col body page with images)
const pg=1;
const html=doc.renderPageHtml?.(pg)||"";
console.log("renderPageHtml len:", html.length);
// wrap it minimally and screenshot
const full=`<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0">${html}</body></html>`;
writeFileSync("/tmp/native.html", full);
const b=await puppeteer.launch({executablePath:"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",headless:true,args:["--no-sandbox"]});
const p=await b.newPage(); await p.setViewport({width:900,height:1300,deviceScaleFactor:1.4});
await p.goto("file:///tmp/native.html",{waitUntil:"networkidle0"});
// screenshot the page container
const el=(await p.$$("body > *"))[0]; if(el) await el.screenshot({path:"/tmp/native.png"}); else await p.screenshot({path:"/tmp/native.png",clip:{x:0,y:0,width:850,height:1200}});
await b.close(); console.log("ok");
