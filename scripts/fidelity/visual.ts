/**
 * Track 2 — 시각 회귀 diff (정답 PDF 필요). 포맷 무관: 미리보기를 PNG 로 찍고 정답 PDF
 * 래스터와 SSIM 비교한다. 사용자가 매번 눈으로 하던 "원본과 같나"를 객관 수치로 대체.
 *
 * 정답지 규칙:
 *   - *.pdf 파일      → 자기 자신이 정답(docloom PDF 미리보기 vs 원본 PDF 래스터).
 *   - 그 외 포맷       → <corpus>/_truth/<같은base>.pdf 가 있으면 사용(없으면 skip).
 *
 * 도구체인: 미리보기 HTML → Chrome 풀페이지 스크린샷 / 정답 PDF → pdftoppm PNG /
 *   SSIM·합성 썸네일 → Chrome canvas(노드 이미지 의존성 0).
 *
 *   npm run fidelity:visual -- [--filter=substr] [--limit=N] [--dpi=110]
 * 산출: scoreboards/visual.json + scoreboards/visual/*.png(썸네일). 리포트는 fidelity.json 의
 *   visual 필드를 합쳐 다시 빌드(run.ts 가 visual.json 있으면 자동 병합).
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync, rmSync, copyFileSync } from "node:fs";
import { join, extname, basename, relative } from "node:path";
import { homedir, tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import puppeteer from "puppeteer-core";
import { renderFile, DOC_EXTS } from "./render.js";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const argv = process.argv.slice(2);
const flag = (n: string, d: string): string => {
  const m = argv.find((a) => a.startsWith(`--${n}=`)); return m ? m.slice(n.length + 3) : d;
};
const DIR = flag("dir", join(homedir(), "docloom-corpus"));
const TRUTH = join(DIR, "_truth");
const FILTER = flag("filter", "");
const LIMIT = Number(flag("limit", "0"));
const DPI = Number(flag("dpi", "110"));
const INCLUDE_FLOW = argv.includes("--include-flow");   // hwp/hwpx 는 흐름미리보기라 기본 제외
const SB = join(process.cwd(), "scoreboards");
const THUMBS = join(SB, "visual");
const FLOW_FMT = new Set(["hwp", "hwpx"]);

interface VisRow {
  name: string; fmt: string; pages: number;
  medianSsim: number; meanSsim: number; worstSsim: number; // median 이 헤드라인(한 쪽 어긋남에 강건)
  failPages: number; flow: boolean; thumbs: string[];
}

function collect(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".") || name === "_truth") continue;
    const p = join(dir, name);
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) collect(p, out);
    else if (DOC_EXTS.has(extname(name).slice(1).toLowerCase())) out.push(p);
  }
  return out;
}

/** 이 문서의 정답 PDF 경로(없으면 null). _truth 는 코퍼스 하위폴더 구조를 미러링(권장),
 *  평평한 _truth/<이름>.pdf 도 폴백 지원. (APFS 는 NFC/NFD 무관하게 lookup 매칭) */
function truthPdf(file: string): string | null {
  if (extname(file).toLowerCase() === ".pdf") return file;            // PDF 는 자기 자신이 정답
  const rel = relative(DIR, file);                                    // 예: "docx/foo.docx"
  const mirrored = join(TRUTH, rel.slice(0, -extname(rel).length) + ".pdf"); // _truth/docx/foo.pdf
  if (existsSync(mirrored)) return mirrored;
  const flat = join(TRUTH, basename(file, extname(file)) + ".pdf");   // _truth/foo.pdf 폴백
  return existsSync(flat) ? flat : null;
}

const safeName = (s: string): string => s.replace(/[^\w.\-]+/g, "_").slice(0, 80);

async function main() {
  if (!existsSync(DIR)) { console.error(`✗ 코퍼스 없음: ${DIR}`); process.exit(2); }
  mkdirSync(THUMBS, { recursive: true });
  let files = collect(DIR).sort().filter((f) => truthPdf(f));
  if (FILTER) files = files.filter((f) => f.includes(FILTER));
  if (LIMIT > 0) files = files.slice(0, LIMIT);
  const hasFlow = files.some((f) => FLOW_FMT.has(extname(f).slice(1).toLowerCase()));
  console.log(`시각 diff: 정답지 있는 ${files.length}개 (정답폴더 ${TRUTH})` +
    (hasFlow ? "  [hwp/hwpx 는 충실렌더(SVG) 브라우저 게이트]" : "") + "\n");
  if (!files.length) {
    console.log(`정답 PDF 가 없습니다. *.pdf 는 자동 대상이고, 그 외 포맷은\n  ${TRUTH}/<원본과같은이름>.pdf 로 넣으면 켜집니다.`);
    return;
  }

  // hwp/hwpx 충실렌더는 브라우저에서 rhwp WASM(실 canvas)로 — 데모 정적 서버 + _verify.html 재사용.
  if (hasFlow && !existsSync(join(process.cwd(), "demo", "docloom.mjs"))) {
    console.error("✗ demo 번들 없음 — 먼저 `npm run demo:build` 필요(hwp 충실렌더 게이트용)."); process.exit(2);
  }
  const srv = hasFlow ? await startDemoServer() : null;
  if (srv) console.log(`데모 서버 :${srv.port} (hwp 충실렌더용)\n`);

  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox", "--disable-gpu", "--allow-file-access-from-files"] });
  const rows: VisRow[] = [];
  try {
    for (let i = 0; i < files.length; i++) {
      const f = files[i]!;
      process.stdout.write(`[${i + 1}/${files.length}] ${basename(f).slice(0, 46)} … `);
      try { const r = await compareOne(browser, f, srv?.port); rows.push(r); console.log(`SSIM 중앙 ${r.medianSsim.toFixed(3)} (최저 ${r.worstSsim.toFixed(3)}, ${r.pages}쪽)`); }
      catch (e) { console.log(`ERR ${(e as Error).message.slice(0, 60)}`); }
    }
  } finally { await browser.close(); srv?.close(); }

  // 기존 visual.json 과 **병합**(이름 키) — docx/pdf 와 hwp 충실렌더를 따로 돌려도 둘 다 보존.
  const vpath = join(SB, "visual.json");
  const merged = new Map<string, VisRow>();
  if (existsSync(vpath)) {
    try { for (const r of (JSON.parse(readFileSync(vpath, "utf8")).rows ?? []) as VisRow[]) merged.set(r.name, r); } catch { /* 무시 */ }
  }
  for (const r of rows) merged.set(r.name, r);          // 이번 실행이 우선
  writeFileSync(vpath, JSON.stringify({ dir: DIR, dpi: DPI, rows: [...merged.values()] }, null, 2));
  console.log(`\n시각 결과: ${vpath} (이번 ${rows.length}개, 누적 ${merged.size}개). run.ts --report-only 로 리포트 병합.`);
  const bad = rows.filter((r) => !r.flow && r.medianSsim < 0.85).sort((a, b) => a.medianSsim - b.medianSsim);
  if (bad.length) { console.log(`\n⚠ 중앙SSIM<0.85 (레이아웃충실 포맷, 눈으로 확인 권장) ${bad.length}개:`); for (const r of bad) console.log(`  중앙 ${r.medianSsim.toFixed(3)} (최저 ${r.worstSsim.toFixed(3)}) ${r.name}`); }
}

/** 한 문서: 미리보기 PNG ↔ 정답 PDF PNG SSIM(페이지별) + 썸네일. */
async function compareOne(browser: import("puppeteer-core").Browser, file: string, port?: number): Promise<VisRow> {
  const truth = truthPdf(file)!;
  const ext = extname(file).slice(1).toLowerCase();
  const faithfulHwp = FLOW_FMT.has(ext);                 // hwp/hwpx → 브라우저 충실렌더(SVG)
  const work = join(tmpdir(), "docloom-vis-" + safeName(basename(file)));
  rmSync(work, { recursive: true, force: true }); mkdirSync(work, { recursive: true });

  // ① 정답 PDF → 페이지별 PNG
  execFileSync("pdftoppm", ["-png", "-r", String(DPI), truth, join(work, "truth")], { stdio: "ignore" });
  const truthPngs = readdirSync(work).filter((n) => n.startsWith("truth") && n.endsWith(".png")).sort()
    .map((n) => join(work, n));
  if (!truthPngs.length) throw new Error("pdftoppm 산출 없음");

  // ② 미리보기 → 페이지별 PNG.
  //   hwp/hwpx: 브라우저에서 rhwp 충실렌더(SVG, 절대좌표=PDF 와 페이지정렬) — 게이트 유효.
  //   그 외: Node 렌더 HTML 을 Chrome 에 띄워 페이지컨테이너 스크린샷(reflow → SSIM 은 트리아지).
  let previewPngs: string[];
  if (faithfulHwp) {
    if (!port) throw new Error("hwp 충실렌더 서버 미기동");
    previewPngs = await shootHwpFaithful(browser, file, work, port);
  } else {
    const r = await renderFile(file);
    if (r.error) throw new Error("render: " + r.error);
    previewPngs = await shootPreview(browser, r.html, work);
  }

  // ③ 페이지 짝지어 SSIM + 썸네일 합성
  const n = Math.min(truthPngs.length, previewPngs.length);
  const page = await browser.newPage();
  await page.evaluate(() => { (window as never as Record<string, unknown>).__name ||= (f: unknown) => f; });
  const ssims: number[] = []; const thumbs: string[] = [];
  try {
    for (let i = 0; i < n; i++) {
      const { ssim, thumb } = await ssimAndThumb(page, previewPngs[i]!, truthPngs[i]!);
      ssims.push(ssim);
      const out = join(THUMBS, `${safeName(basename(file))}-p${i + 1}.png`);
      writeFileSync(out, Buffer.from(thumb, "base64"));
      thumbs.push("visual/" + basename(out));
    }
  } finally { await page.close(); rmSync(work, { recursive: true, force: true }); }

  const sorted = [...ssims].sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)]! : 0;
  const mean = ssims.length ? ssims.reduce((s, x) => s + x, 0) / ssims.length : 0;
  const worst = sorted.length ? sorted[0]! : 0;
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  return {
    name: basename(file), fmt: ext, pages: Math.max(truthPngs.length, previewPngs.length),
    medianSsim: r3(median), meanSsim: r3(mean), worstSsim: r3(worst),
    failPages: ssims.filter((s) => s < 0.85).length, flow: false, // hwp 도 충실렌더라 비교가능 게이트
    thumbs: thumbs.slice(0, 6),
  };
}

const PAGE_SELECTORS = [".hp-page", ".hp-paper", ".docloom-page", ".pptx-stage", ".pdf-page", ".page", ".pdfpage"];

/** demo/ 를 서빙하는 최소 정적 서버(파이썬 의존 제거, 포트 자동). */
function startDemoServer(): Promise<{ port: number; close: () => void }> {
  const demoDir = join(process.cwd(), "demo");
  const TYPES: Record<string, string> = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript",
    ".wasm": "application/wasm", ".json": "application/json", ".css": "text/css",
  };
  const server: Server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? "/").split("?")[0]!);
    const fp = join(demoDir, path === "/" ? "index.html" : path);
    if (!fp.startsWith(demoDir)) { res.statusCode = 403; return res.end(); }
    try {
      const buf = readFileSync(fp);
      res.setHeader("Content-Type", TYPES[extname(fp).toLowerCase()] ?? "application/octet-stream");
      res.end(buf);
    } catch { res.statusCode = 404; res.end(); }
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    resolve({ port: (server.address() as { port: number }).port, close: () => server.close() });
  }));
}

/** hwp/hwpx 를 브라우저 _verify.html(mode=svg, rhwp WASM+실 canvas)로 충실렌더 → 페이지별 PNG.
 *  ⚠ Node 렌더와 달리 실 canvas 메트릭이라 레이아웃 정확. 절대좌표 SVG 라 PDF 와 페이지 정렬됨. */
async function shootHwpFaithful(browser: import("puppeteer-core").Browser, file: string, work: string, port: number): Promise<string[]> {
  const samplesDir = join(process.cwd(), "demo", "_samples");
  mkdirSync(samplesDir, { recursive: true });
  const sampleName = "_vis" + extname(file).toLowerCase();   // _vis.hwp / _vis.hwpx (직렬 루프라 단일 임시명 OK)
  const samplePath = join(samplesDir, sampleName);
  copyFileSync(file, samplePath);
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 1300, deviceScaleFactor: 1 });
  try {
    await page.goto(`http://127.0.0.1:${port}/_verify.html?f=${encodeURIComponent(sampleName)}&mode=svg`,
      { waitUntil: "load", timeout: 60000 });
    await page.waitForFunction(() => /^verify-(ready|error)/.test(document.title), { timeout: 60000 });
    if ((await page.title()).startsWith("verify-error")) {
      throw new Error("verify-error: " + (await page.evaluate(() => document.body.innerText).catch(() => "")).slice(0, 80));
    }
    // _verify.html 은 SVG 페이지를 iframe(srcdoc) 안에 넣는다 → iframe 프레임에서 쿼리.
    const frame = page.frames().find((fr) => fr !== page.mainFrame());
    if (!frame) throw new Error("iframe 없음");
    await frame.waitForSelector(".hp-paper, .hp-page", { timeout: 20000 });
    await new Promise((r) => setTimeout(r, 800));          // 이미지 디코드 여유
    const els = await frame.$$(".hp-paper, .hp-page");
    const out: string[] = [];
    for (let i = 0; i < els.length; i++) {
      const p = join(work, `prev-${String(i).padStart(3, "0")}.png`);
      try { await els[i]!.screenshot({ path: p as `${string}.png` }); out.push(p); } catch { /* 0크기 skip */ }
    }
    return out;
  } finally { await page.close(); rmSync(samplePath, { force: true }); }
}

/** 미리보기 HTML 을 Chrome 에 띄워 페이지 컨테이너별로 스크린샷(없으면 body 풀페이지 1장). */
async function shootPreview(browser: import("puppeteer-core").Browser, html: string, work: string): Promise<string[]> {
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 1300, deviceScaleFactor: 1 });
  // tsx/esbuild 가 evaluate 콜백의 named 함수에 __name 래퍼를 주입 → 브라우저용 shim.
  await page.evaluateOnNewDocument(() => { (window as never as Record<string, unknown>).__name = (f: unknown) => f; });
  try {
    await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 60000 });
    // 이미지 디코드 + paginator JS 완료 대기(data URI 라 network idle 은 안 옴)
    await page.evaluate(async () => {
      const imgs = Array.from(document.images).filter((i) => !i.complete);
      await Promise.all(imgs.map((i) => new Promise<void>((res) => { i.onload = i.onerror = () => res(); })));
    }).catch(() => {});
    await new Promise((r) => setTimeout(r, 800));
    const sel = await page.evaluate((sels) => {
      for (const s of sels) if (document.querySelectorAll(s).length) return s;
      return null;
    }, PAGE_SELECTORS);
    const out: string[] = [];
    if (sel) {
      const els = await page.$$(sel);
      for (let i = 0; i < els.length; i++) {
        const p = join(work, `prev-${String(i).padStart(3, "0")}.png`);
        try { await els[i]!.screenshot({ path: p as `${string}.png` }); out.push(p); } catch { /* 0크기 요소 skip */ }
      }
    }
    if (!out.length) { // 페이지 컨테이너 없음 → 풀페이지 1장
      const p = join(work, "prev-000.png");
      await page.screenshot({ path: p as `${string}.png`, fullPage: true });
      out.push(p);
    }
    return out;
  } finally { await page.close(); }
}

/** 두 PNG → (SSIM, 나란히 합성 썸네일 base64). Chrome canvas 로 계산(노드 이미지 의존성 0). */
async function ssimAndThumb(page: import("puppeteer-core").Page, previewPng: string, truthPng: string): Promise<{ ssim: number; thumb: string }> {
  const a = "data:image/png;base64," + readFileSync(previewPng).toString("base64");
  const b = "data:image/png;base64," + readFileSync(truthPng).toString("base64");
  return await page.evaluate(async (aUrl, bUrl) => {
    const load = (u: string) => new Promise<HTMLImageElement>((res, rej) => {
      const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = u;
    });
    const [ia, ib] = await Promise.all([load(aUrl), load(bUrl)]);
    // ⚠ SSIM 은 **구조(레이아웃) 일치**를 보도록 저해상도+블러로 계산한다. 고해상도 전체페이지
    // SSIM 은 글자 안티에일리어싱·미세 오프셋에 과민해 눈으로 동일한 텍스트 문서도 0.5 로
    // 떨어뜨린다(ReWork 검증). 저해상도화하면 텍스트가 회색 띠가 되어 "배치·여백이 맞나"를 본다.
    const SW = 164, SH = Math.round(SW * 1.414);          // SSIM 계산 해상도(텍스트→구조)
    const luma = (img: HTMLImageElement): Float64Array => {
      const c = document.createElement("canvas"); c.width = SW; c.height = SH;
      const ctx = c.getContext("2d")!; ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, SW, SH);
      ctx.drawImage(img, 0, 0, SW, SH);
      const d = ctx.getImageData(0, 0, SW, SH).data; const g0 = new Float64Array(SW * SH);
      for (let i = 0; i < SW * SH; i++) g0[i] = 0.299 * d[i * 4]! + 0.587 * d[i * 4 + 1]! + 0.114 * d[i * 4 + 2]!;
      // 3×3 박스 블러(서브픽셀 글자 노이즈 억제)
      const g = new Float64Array(SW * SH);
      for (let y = 0; y < SH; y++) for (let x = 0; x < SW; x++) {
        let s = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const yy = y + dy, xx = x + dx;
          if (yy >= 0 && yy < SH && xx >= 0 && xx < SW) { s += g0[yy * SW + xx]!; n++; }
        }
        g[y * SW + x] = s / n;
      }
      return g;
    };
    const ga = luma(ia), gb = luma(ib);
    const C1 = 6.5025, C2 = 58.5225, B = 8; let sum = 0, cnt = 0;
    for (let by = 0; by + B <= SH; by += B) for (let bx = 0; bx + B <= SW; bx += B) {
      let ma = 0, mb = 0; for (let y = 0; y < B; y++) for (let x = 0; x < B; x++) { const i = (by + y) * SW + (bx + x); ma += ga[i]!; mb += gb[i]!; }
      ma /= B * B; mb /= B * B;
      let va = 0, vb = 0, cov = 0;
      for (let y = 0; y < B; y++) for (let x = 0; x < B; x++) { const i = (by + y) * SW + (bx + x); const da = ga[i]! - ma, db = gb[i]! - mb; va += da * da; vb += db * db; cov += da * db; }
      va /= B * B - 1; vb /= B * B - 1; cov /= B * B - 1;
      sum += ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2)); cnt++;
    }
    const ssim = cnt ? sum / cnt : 0;
    // 나란히 썸네일(좌:미리보기 / 우:정답) — 보기용이라 더 큰 해상도로.
    const TW = 300, TH = Math.round(TW * 1.414);
    const tc = document.createElement("canvas"); tc.width = TW * 2 + 6; tc.height = TH;
    const tx = tc.getContext("2d")!; tx.fillStyle = "#ddd"; tx.fillRect(0, 0, tc.width, TH);
    tx.drawImage(ia, 0, 0, TW, TH); tx.drawImage(ib, TW + 6, 0, TW, TH);
    return { ssim, thumb: tc.toDataURL("image/png").split(",")[1]! };
  }, a, b);
}

main().catch((e) => { console.error(e); process.exit(1); });
