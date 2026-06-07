/**
 * docloom 충실도 하베스트 v2 — 코퍼스 전체를 돌려 결함 스코어보드 + HTML 리포트 생성.
 *
 *   npm run fidelity                          # 기본 코퍼스(~/docloom-corpus) 전체
 *   npm run fidelity -- --filter=상장          # 파일명 부분일치
 *   npm run fidelity -- --limit=20 --max-mb=20
 *   npm run fidelity -- --dir=/path/to/corpus
 *
 * Track 1(구조 누락, 정답지 불필요)은 항상 돈다. Track 2(시각 diff)는 코퍼스의
 * _truth/<같은이름>.pdf 가 있는 파일에서만 켜진다(scripts/fidelity/visual.ts, 별도 단계).
 *
 * 산출물: scoreboards/fidelity.{json,csv} + scoreboards/fidelity-report.html
 */
import { readdirSync, statSync, writeFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, extname, basename } from "node:path";
import { homedir } from "node:os";
import { renderFile, DOC_EXTS } from "./render.js";
import { rhwpOracles, genericOracles, type Finding } from "./oracles.js";
import { buildReport, type ReportRow } from "./report.js";
import { rhwpBuildId } from "../rhwpNode.js";

const argv = process.argv.slice(2);
const flag = (n: string, d: string): string => {
  const m = argv.find((a) => a.startsWith(`--${n}=`));
  return m ? m.slice(n.length + 3) : d;
};
const REPORT_ONLY = argv.includes("--report-only");
const DIR = flag("dir", join(homedir(), "docloom-corpus"));
const FILTER = flag("filter", "");
const LIMIT = Number(flag("limit", "0"));
const MAX_MB = Number(flag("max-mb", "40"));
const OUT_DIR = join(process.cwd(), "scoreboards");

const SEV_WEIGHT: Record<string, number> = { high: 100, med: 10, low: 1 };

interface Row extends ReportRow { file: string; ext: string; error?: string }

/** 재귀로 문서 파일 수집(_truth 폴더와 이미지 자산 제외). */
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

function scoreOf(findings: Finding[]): number {
  return findings.reduce((s, f) => s + (SEV_WEIGHT[f.severity] ?? 1) * Math.min(f.count, 50), 0);
}

async function main() {
  // --report-only: 재렌더 없이 기존 fidelity.json(+visual.json)으로 리포트만 다시 굽는다.
  if (REPORT_ONLY) {
    const fj = JSON.parse(readFileSync(join(OUT_DIR, "fidelity.json"), "utf8")) as { dir: string; build: string; rows: Row[] };
    writeReport(fj.rows, fj.dir, fj.build);
    console.log(`리포트 재생성: ${join(OUT_DIR, "fidelity-report.html")} (${fj.rows.length}행)`);
    return;
  }
  if (!existsSync(DIR)) { console.error(`✗ 코퍼스 없음: ${DIR}`); process.exit(2); }
  let files = collect(DIR).sort();
  if (FILTER) files = files.filter((f) => f.includes(FILTER));
  if (LIMIT > 0) files = files.slice(0, LIMIT);
  console.log(`충실도 하베스트: ${files.length}개 (dir=${DIR})  rhwp=${rhwpBuildId().slice(0, 12)}\n`);

  const rows: Row[] = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i]!;
    process.stdout.write(`[${i + 1}/${files.length}] ${basename(f).slice(0, 50)} … `);
    const ext = extname(f).slice(1).toLowerCase();
    const sizeMB = Math.round((statSync(f).size / 1048576) * 10) / 10;
    if (sizeMB > MAX_MB) { console.log(`skip(${sizeMB}MB)`); continue; }

    const r = await renderFile(f);
    let findings: Finding[] = [];
    let pages: number | undefined;
    if (r.error) {
      findings = [{ dim: "render", severity: "high", count: 1, detail: r.error }];
    } else if ((ext === "hwp" || ext === "hwpx") && r.doc) {
      pages = safePages(r.doc);
      findings = rhwpOracles(r.doc, r.html);
    } else {
      findings = genericOracles(r);
    }
    const score = scoreOf(findings);
    rows.push({
      file: f, name: r.name, ext, fmt: r.fmt, sizeMB, ms: r.ms, pages,
      error: r.error, findings, score,
    });
    console.log(r.error ? `ERR ${r.error.slice(0, 40)}`
      : score === 0 ? "clean"
      : `score=${score} [${findings.map((x) => x.dim).join(",")}]`);
  }

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const build = rhwpBuildId();

  writeFileSync(join(OUT_DIR, "fidelity.json"),
    JSON.stringify({ dir: DIR, build, files: files.length, rows }, null, 2));

  const cols = ["name", "fmt", "ext", "sizeMB", "pages", "score", "error"] as const;
  const csv = [cols.join(",")].concat(rows.map((r) =>
    cols.map((c) => csvCell((r as any)[c])).join(","))).join("\n");
  writeFileSync(join(OUT_DIR, "fidelity.csv"), csv);

  writeReport(rows, DIR, build);

  // 요약
  const bad = rows.filter((r) => r.score > 0 || r.error);
  const byDim = new Map<string, number>();
  for (const r of rows) for (const f of r.findings) byDim.set(f.dim, (byDim.get(f.dim) ?? 0) + 1);
  console.log(`\n── 요약 ──`);
  console.log(`결함 있는 파일: ${bad.length}/${rows.length}  (clean ${rows.length - bad.length})`);
  for (const [d, n] of [...byDim.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${d}: ${n}`);
  console.log(`\n리포트: ${join(OUT_DIR, "fidelity-report.html")}`);
  console.log(`스코어보드: ${join(OUT_DIR, "fidelity.json")} / .csv`);
}

/** 행 + (있으면) visual.json 을 병합해 HTML 리포트를 쓴다. 전체렌더/리포트전용 공용. */
function writeReport(rows: Row[], dir: string, build: string): void {
  const when = new Date(statSync(dir).mtime).toISOString().slice(0, 10) + " run";
  const visPath = join(OUT_DIR, "visual.json");
  const visMap = new Map<string, ReportRow["visual"]>();
  if (existsSync(visPath)) {
    try {
      const vj = JSON.parse(readFileSync(visPath, "utf8")) as { rows: { name: string; pages: number; medianSsim?: number; worstSsim: number; failPages: number; flow?: boolean; thumbs: string[] }[] };
      for (const v of vj.rows) visMap.set(v.name, { pages: v.pages, medianSsim: v.medianSsim ?? v.worstSsim, worstSsim: v.worstSsim, failPages: v.failPages, flow: v.flow ?? (v.name.toLowerCase().endsWith(".hwp") || v.name.toLowerCase().endsWith(".hwpx")), thumbs: v.thumbs });
    } catch { /* 무시 */ }
  }
  const reportRows: ReportRow[] = rows.map((r) => ({
    name: r.name, fmt: r.fmt, sizeMB: r.sizeMB, ms: r.ms, pages: r.pages, error: r.error,
    findings: r.findings, score: r.score, visual: visMap.get(r.name),
  }));
  writeFileSync(join(OUT_DIR, "fidelity-report.html"), buildReport(reportRows, { dir, build, when }));
}

function safePages(doc: { pageCount(): number }): number | undefined {
  try { return doc.pageCount(); } catch { return undefined; }
}
function csvCell(v: unknown): string { return v == null ? "" : `"${String(v).replace(/"/g, '""')}"`; }

main().catch((e) => { console.error(e); process.exit(1); });
