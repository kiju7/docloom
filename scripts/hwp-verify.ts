/**
 * HWP/HWPX 충실 렌더링 검증 하베스트 (Stage 1, Tier A/B).
 *
 * 한글 앱이 없어 "픽셀 동일"을 직접 증명할 수 없으므로, 싸고 결정론적인 **텍스트 완전성**과
 * **앱 자체 추출 텍스트(PrvText) 교차검증**으로 회귀를 잡는다. 결과는 파일별 스코어보드(JSON+CSV)
 * — 177개를 눈으로 안 보고 추적하고, 엔진 수정마다 재실행해 대상 개선 + 무회귀를 확인하는 게이트.
 *
 * Tier A — 텍스트 완전성 오라클(이미지 불필요):
 *   - 정답 글자집합 = rhwp 데이터 API(getTextRange/getTextInCell)로 추출한 본문·셀 텍스트.
 *   - SVG 경로: svgGlyphSoup(렌더된 <text> 글자) 가 정답을 얼마나 덮는지 + 표별 누락 탐지
 *     (알려진 "마지막 표 셀 텍스트 누락" 버그를 자동 pass/fail 로).
 *   - HTML 경로: pageContentOverflow(renderPageHtml) 최대값 — "글 뒤 배경이 본문을 페이지 밖으로
 *     밀어내는" 버그를 px 로 정량화.
 * Tier B — PrvText 교차검증:
 *   - HWPX Preview/PrvText.txt · HWP OLE PrvText 스트림(앱 자체 텍스트 추출)을 rhwp 추출과 비교.
 *
 * 사용:
 *   tsx scripts/hwp-verify.ts [dir] [--max-mb=40] [--pages=20] [--limit=N] [--out=path] [--filter=substr]
 *   기본 dir = /Users/jd-kimkiju/Desktop/test_sample
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, extname, basename, relative } from "node:path";
import { loadRhwp, rhwpBuildId, type HwpDocCtor } from "./rhwpNode.js";
import { svgGlyphSoup, pageContentOverflow, type RhwpDoc } from "../src/rhwp/hwpEdit.js";
import { readZip } from "../src/core/zip.js";
import { readCfb, isCfbBytes } from "../src/core/cfb.js";

// ───────────────────────── CLI ─────────────────────────
const argv = process.argv.slice(2);
const flag = (name: string, def: string): string => {
  const m = argv.find((a) => a.startsWith(`--${name}=`));
  return m ? m.slice(name.length + 3) : def;
};
const positional = argv.filter((a) => !a.startsWith("--"));
const DIR = positional[0] ?? "/Users/jd-kimkiju/Desktop/test_sample";
const MAX_MB = Number(flag("max-mb", "40"));    // 이 크기 초과 파일은 통째로 skip(메모리 보호)
// ⚠ 정답텍스트는 전체 페이지에서 뽑으므로 렌더 페이지를 제한하면 커버리지가 거짓으로 낮아진다.
// 기본은 사실상 무제한(전체 렌더). 초과 시 partial 로 표시하고 커버리지 통계에서 제외한다.
const MAX_PAGES = Number(flag("pages", "600")); // 파일당 렌더할 최대 페이지(기본 사실상 전체)
const LIMIT = Number(flag("limit", "0"));      // 0 = 전체
const FILTER = flag("filter", "");             // 경로 부분일치 필터
const OUT = flag("out", join(process.cwd(), "hwp-verify-scoreboard"));

// ───────────────────────── 유틸 ─────────────────────────
const safe = <T,>(fn: () => T): T | undefined => { try { return fn(); } catch { return undefined; } };
const pj = <T = any,>(s: string | undefined): T | null => {
  if (typeof s !== "string") return null;
  try { return JSON.parse(s) as T; } catch { return null; }
};
const strip = (s: string): string => s.replace(/\s+/g, "");

/** 디렉터리 재귀로 .hwp/.hwpx 수집. */
function collect(dir: string, out: string[] = []): string[] {
  for (const name of safe(() => readdirSync(dir)) ?? []) {
    if (name.startsWith(".")) continue;
    const p = join(dir, name);
    const st = safe(() => statSync(p));
    if (!st) continue;
    if (st.isDirectory()) collect(p, out);
    else if ([".hwp", ".hwpx"].includes(extname(name).toLowerCase())) out.push(p);
  }
  return out;
}

/** PrvText 바이트 → 문자열(UTF-16LE BOM 우선, 아니면 UTF-8). */
function decodePrvText(b: Uint8Array): string {
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return new TextDecoder("utf-16le").decode(b.subarray(2));
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return new TextDecoder("utf-16be").decode(b.subarray(2));
  // BOM 없음: HWP OLE PrvText 는 UTF-16LE 가 흔함 → NUL 비율로 추정.
  let nul = 0;
  for (let i = 1; i < Math.min(b.length, 200); i += 2) if (b[i] === 0) nul++;
  return nul > 20 ? new TextDecoder("utf-16le").decode(b) : new TextDecoder("utf-8").decode(b);
}

/** 앱 자체 텍스트 추출(PrvText). 없으면 null. */
function prvText(bytes: Uint8Array, isHwpx: boolean): string | null {
  if (isHwpx) {
    const parts = safe(() => readZip(bytes));
    const b = parts?.["Preview/PrvText.txt"];
    return b ? decodePrvText(b) : null;
  }
  if (isCfbBytes(bytes)) {
    const b = safe(() => readCfb(bytes))?.streams["PrvText"];
    return b ? decodePrvText(b) : null;
  }
  return null;
}

/** 두 문자열의 멀티셋 글자 커버리지 = (truth 글자 중 cand 에 있는 수) / truthLen. [0,1], cap 1. */
function multisetCoverage(truth: string, cand: string): number {
  if (!truth.length) return 1;
  const have = new Map<string, number>();
  for (const c of cand) have.set(c, (have.get(c) ?? 0) + 1);
  let hit = 0;
  for (const c of truth) {
    const n = have.get(c) ?? 0;
    if (n > 0) { hit++; have.set(c, n - 1); }
  }
  return hit / truth.length;
}

// ───────────────────────── 정답 텍스트 추출(데이터 API) ─────────────────────────
interface Truth { text: string; tableProbes: string[] }

/** 한 표의 가장 긴 셀 문단 텍스트(공백제거, 누락 탐지 지문). */
function longestCellProbe(doc: RhwpDoc, s: number, p: number, ci: number): string {
  const dim = pj<{ cellCount: number }>(safe(() => doc.getTableDimensions(s, p, ci)));
  let best = "";
  for (let cell = 0; cell < (dim?.cellCount ?? 0); cell++) {
    const cpc = safe(() => doc.getCellParagraphCount(s, p, ci, cell)) ?? 0;
    for (let cp = 0; cp < cpc; cp++) {
      const l = safe(() => doc.getCellParagraphLength(s, p, ci, cell, cp)) ?? 0;
      if (l <= 0) continue;
      const t = strip(safe(() => doc.getTextInCell(s, p, ci, cell, cp, 0, l)) ?? "");
      if (t.length > best.length) best = t;
    }
  }
  return best;
}

/** 문서 전체의 정답 텍스트(본문 + 셀) + 표별 지문. */
function extractTruth(doc: RhwpDoc): Truth {
  const info = pj<{ sectionCount?: number }>(safe(() => doc.getDocumentInfo()));
  const secN = Math.max(1, info?.sectionCount ?? 1);
  let text = "";
  const tableProbes: string[] = [];
  for (let s = 0; s < secN; s++) {
    const pc = safe(() => doc.getParagraphCount(s)) ?? 0;
    for (let p = 0; p < pc; p++) {
      const ctrls = pj<number[]>(safe(() => doc.getControlTextPositions(s, p))) ?? [];
      if (ctrls.length === 0) {
        const plen = safe(() => doc.getParagraphLength(s, p)) ?? 0;
        if (plen > 0) text += safe(() => doc.getTextRange(s, p, 0, plen)) ?? "";
        continue;
      }
      for (let ci = 0; ci < ctrls.length; ci++) {
        const dim = pj<{ cellCount: number }>(safe(() => doc.getTableDimensions(s, p, ci)));
        if (!dim || !(dim.cellCount > 0)) continue;
        for (let cell = 0; cell < dim.cellCount; cell++) {
          const cpc = safe(() => doc.getCellParagraphCount(s, p, ci, cell)) ?? 0;
          for (let cp = 0; cp < cpc; cp++) {
            const l = safe(() => doc.getCellParagraphLength(s, p, ci, cell, cp)) ?? 0;
            if (l > 0) text += safe(() => doc.getTextInCell(s, p, ci, cell, cp, 0, l)) ?? "";
          }
        }
        const probe = longestCellProbe(doc, s, p, ci);
        if (probe.length >= 4) tableProbes.push(probe);
      }
    }
  }
  return { text: strip(text), tableProbes };
}

// ───────────────────────── 한 파일 채점 ─────────────────────────
interface Row {
  file: string; format: string; sizeMB: number;
  ok: boolean; error?: string; skipped?: boolean;
  pages?: number;             // 문서 총 페이지
  rendered?: number;          // 실제 렌더한 페이지(MAX_PAGES 캡)
  partial?: boolean;          // pages > rendered → 커버리지 통계 제외(정답은 전체, 렌더는 일부)
  truthChars?: number;
  svgCoverage?: number;       // [0,1] 정답 글자 중 SVG 에 렌더된 비율
  svgMissingTables?: number;  // 지문이 SVG 글자수프에 없는 표 수(알려진 누락 버그)
  svgTables?: number;         // 지문 보유 표 수
  htmlMaxOverflowPx?: number; // renderPageHtml 최대 콘텐츠 오버플로
  prvTextChars?: number;      // 앱 PrvText 글자수(공백제거)
  prvCoverage?: number;       // [0,1] PrvText 글자 중 rhwp 추출에 있는 비율
}

function scoreFile(path: string, Ctor: HwpDocCtor): Row {
  const format = extname(path).slice(1).toLowerCase();
  const sizeMB = Math.round((statSync(path).size / 1048576) * 10) / 10;
  const row: Row = { file: path, format, sizeMB, ok: false };
  if (sizeMB > MAX_MB) { row.skipped = true; return row; }

  let bytes: Uint8Array;
  try { bytes = new Uint8Array(readFileSync(path)); }
  catch (e) { row.error = `read: ${(e as Error).message}`; return row; }

  let doc: RhwpDoc & { pageCount(): number };
  try { doc = new Ctor(bytes); } catch (e) { row.error = `parse: ${(e as Error).message}`; return row; }
  row.ok = true;

  // 정답 텍스트
  const truth = extractTruth(doc);
  row.truthChars = truth.text.length;

  const totalPages = safe(() => doc.pageCount()) ?? 0;
  const pageN = Math.min(totalPages, MAX_PAGES);
  row.pages = totalPages;
  row.rendered = pageN;
  row.partial = totalPages > pageN; // 일부만 렌더 → svgCoverage/missingTables 신뢰 불가

  // Tier A — SVG
  const svgs: string[] = [];
  for (let i = 0; i < pageN; i++) {
    const svg = safe(() => doc.renderPageSvg?.(i));
    if (svg && svg.length < 6_000_000) svgs.push(svg);
  }
  if (svgs.length) {
    const soup = svgGlyphSoup(svgs);
    row.svgCoverage = Math.round(multisetCoverage(truth.text, soup) * 1000) / 1000;
    row.svgTables = truth.tableProbes.length;
    row.svgMissingTables = truth.tableProbes.filter((pr) => !soup.includes(pr)).length;
  }

  // Tier A — HTML 오버플로
  let worst = 0;
  for (let i = 0; i < pageN; i++) {
    const h = safe(() => doc.renderPageHtml?.(i));
    if (h) worst = Math.max(worst, pageContentOverflow(h));
  }
  row.htmlMaxOverflowPx = Math.round(worst);

  // Tier B — PrvText
  const prv = prvText(bytes, format === "hwpx");
  if (prv != null) {
    const p = strip(prv);
    row.prvTextChars = p.length;
    row.prvCoverage = Math.round(multisetCoverage(p, truth.text) * 1000) / 1000;
  }
  return row;
}

// ───────────────────────── 메인 ─────────────────────────
async function main() {
  const Ctor = await loadRhwp();
  if (!Ctor) {
    console.error("✗ rhwp WASM 산출물을 찾지 못함(vendor/rhwp 또는 node_modules/@rhwp/core). 빌드/벤더링 필요.");
    process.exit(2);
  }
  console.log(`rhwp build: ${rhwpBuildId()}`);
  if (!existsSync(DIR)) { console.error(`✗ 디렉터리 없음: ${DIR}`); process.exit(2); }

  let files = collect(DIR).sort();
  if (FILTER) files = files.filter((f) => f.includes(FILTER));
  if (LIMIT > 0) files = files.slice(0, LIMIT);
  console.log(`대상 ${files.length}개 (dir=${DIR}, max-mb=${MAX_MB}, pages=${MAX_PAGES})\n`);

  const rows: Row[] = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i]!;
    process.stdout.write(`[${i + 1}/${files.length}] ${basename(f)} … `);
    let row: Row;
    try { row = scoreFile(f, Ctor); }
    catch (e) { row = { file: f, format: extname(f).slice(1), sizeMB: 0, ok: false, error: `fatal: ${(e as Error).message}` }; }
    rows.push(row);
    if (row.skipped) console.log(`skip(${row.sizeMB}MB)`);
    else if (!row.ok) console.log(`ERR ${row.error}`);
    else console.log(
      `pages=${row.pages} truth=${row.truthChars} svgCov=${row.svgCoverage ?? "-"} ` +
      `miss=${row.svgMissingTables ?? "-"}/${row.svgTables ?? "-"} ovf=${row.htmlMaxOverflowPx} ` +
      `prvCov=${row.prvCoverage ?? "-"}`,
    );
  }

  // 스코어보드 출력
  writeFileSync(`${OUT}.json`, JSON.stringify({ build: rhwpBuildId(), dir: DIR, rows }, null, 2));
  const cols = ["file","format","sizeMB","ok","skipped","partial","error","pages","rendered","truthChars","svgCoverage","svgTables","svgMissingTables","htmlMaxOverflowPx","prvTextChars","prvCoverage"] as const;
  const csv = [cols.join(",")].concat(rows.map((r) =>
    cols.map((c) => { const v = (r as any)[c]; return v == null ? "" : `"${String(v).replace(/"/g, '""')}"`; }).join(","),
  )).join("\n");
  writeFileSync(`${OUT}.csv`, csv);

  // 요약 (커버리지 통계는 전체 렌더된 파일만 — partial 제외해 캡 아티팩트 차단)
  const loaded = rows.filter((r) => r.ok);
  const full = loaded.filter((r) => !r.partial);
  const missTbl = full.filter((r) => (r.svgMissingTables ?? 0) > 0);
  const overflow = full.filter((r) => (r.htmlMaxOverflowPx ?? 0) > 200);
  const lowCov = full.filter((r) => (r.svgCoverage ?? 1) < 0.95 && (r.truthChars ?? 0) > 50);
  // ⚠ 텍스트 완전성은 한글 앱 ground-truth 없이 자동 검증 불가가 결론:
  //  - svgCoverage/missingTables: SVG <text> 마크업이 공간순·래스터(<image>)라 거짓양성 多.
  //  - prvCoverage: PrvText 가 잘린 미리보기(truth 6301 vs prv 810 사례)거나 머리말/필드 포함
  //    (prv>truth)이라 완전성 기준으로 부적합. **레이아웃 불변(회귀)용 invariant 로만** 사용.
  // 유일한 신뢰 자동 신호 = HTML 오버플로(off-page 텍스트, dump-tree 로 좌표 확인됨).
  const lowPrv = full.filter((r) => r.prvCoverage != null && r.prvCoverage < 0.9 && (r.truthChars ?? 0) > 200);
  console.log(`\n── 요약 ──`);
  console.log(`로드 성공: ${loaded.length}/${rows.length}  (skip ${rows.filter((r)=>r.skipped).length}, err ${rows.filter((r)=>!r.ok&&!r.skipped).length}, partial ${loaded.filter((r)=>r.partial).length})`);
  console.log(`[신뢰] HTML 오버플로>200px 파일: ${overflow.length}   ← 유일한 신뢰 자동 신호(레이아웃/페이지네이션)`);
  console.log(`[참고·노이즈] PrvText<0.9: ${lowPrv.length}(앱 PrvText 절단/범위차), SVG표누락: ${missTbl.length}, SVGcov<0.95: ${lowCov.length}  — 완전성 신호로 신뢰 금지, 회귀 invariant 로만`);
  console.log(`\n스코어보드: ${OUT}.json / ${OUT}.csv`);
}

main().catch((e) => { console.error(e); process.exit(1); });
