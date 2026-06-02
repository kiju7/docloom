/**
 * 브라우저(설치된 Chrome)에서 rhwp WASM 을 실제 canvas 폰트 메트릭으로 구동해 한글 미리보기를
 * 렌더하고 첫 페이지를 스크린샷한다 — 프로젝트의 진짜 시각 검증 도구.
 * 사용: tsx scripts/shot.ts <sampleFile in demo/_samples> <out.png> [faithful|tree] [pageIndex]
 * 전제: demo 정적 서버가 PORT(기본 8137)에서 demo/ 를 서빙 중이어야 한다.
 */
import puppeteer from "puppeteer-core";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = process.env.PORT || "8137";
const [file, out, mode = "faithful", pageIdx = "0"] = process.argv.slice(2);
if (!file || !out) { console.error("사용: shot.ts <file> <out.png> [faithful|tree] [pageIdx]"); process.exit(2); }

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox", "--disable-gpu"] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1000, height: 1400, deviceScaleFactor: 2 });
  const url = `http://localhost:${PORT}/_verify.html?f=${encodeURIComponent(file)}&mode=${mode}`;
  await page.goto(url, { waitUntil: "load", timeout: 30000 });
  await page.waitForFunction(() => /^verify-(ready|error)/.test(document.title), { timeout: 30000 });
  const title = await page.title();
  if (title === "verify-error") {
    console.error("RENDER ERROR:", await page.evaluate(() => document.body.innerText));
    process.exit(1);
  }
  // iframe(srcdoc) 안의 N번째 페이지 요소를 스크린샷.
  const frame = page.frames().find((f) => f !== page.mainFrame());
  if (!frame) throw new Error("iframe 없음");
  await frame.waitForSelector(".hp-paper, .hp-page", { timeout: 15000 });
  const pages = await frame.$$(".hp-paper, .hp-page");
  const el = pages[Number(pageIdx)] ?? pages[0];
  if (!el) throw new Error("페이지 요소 없음");
  await new Promise((r) => setTimeout(r, 600)); // 이미지 디코드 여유
  await el.screenshot({ path: out });
  console.log(`shot OK: ${out}  (mode=${mode}, page ${pageIdx}/${pages.length})`);
} finally {
  await browser.close();
}
