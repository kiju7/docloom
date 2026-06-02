import puppeteer from "puppeteer-core";
const CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const [file,out,mode="faithful"]=process.argv.slice(2);
const b=await puppeteer.launch({executablePath:CHROME,headless:true,args:["--no-sandbox","--disable-gpu"]});
const p=await b.newPage();
await p.setViewport({width:920,height:1300,deviceScaleFactor:1});
await p.goto(`http://localhost:${process.env.PORT||"8123"}/_verify.html?f=${encodeURIComponent(file!)}&mode=${mode}`,{waitUntil:"load"});
await p.waitForFunction(()=>/^verify-(ready|error)/.test(document.title),{timeout:30000});
await new Promise(r=>setTimeout(r,800));
// 첫 페이지 영역만: 뷰포트 상단 1300px 캡처(본문 시작 확인용)
await p.screenshot({path:out!, clip:{x:0,y:0,width:920,height:1300}});
console.log("full-view shot:",out);
await b.close();
