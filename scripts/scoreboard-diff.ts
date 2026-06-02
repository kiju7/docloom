/**
 * 두 검증 스코어보드(hwp-verify 산출)를 파일별로 비교 — Ralph 루프의 회귀 게이트.
 * 엔진 수정 후 재검증할 때 "대상이 개선됐고 다른 파일이 회귀하지 않았는지"를 한눈에 본다.
 *
 * 사용: tsx scripts/scoreboard-diff.ts <before.json> <after.json>
 */
import { readFileSync } from "node:fs";

interface Row {
  file: string; ok: boolean; partial?: boolean;
  svgCoverage?: number; svgMissingTables?: number; htmlMaxOverflowPx?: number; prvCoverage?: number;
}
const load = (p: string): Map<string, Row> => {
  const { rows } = JSON.parse(readFileSync(p, "utf8")) as { rows: Row[] };
  return new Map(rows.map((r) => [r.file, r]));
};
const [beforeP, afterP] = [process.argv[2], process.argv[3]];
if (!beforeP || !afterP) { console.error("사용: scoreboard-diff.ts <before.json> <after.json>"); process.exit(2); }
const before = load(beforeP), after = load(afterP);
const base = (f: string) => f.split("/").pop()!.slice(0, 44);

// 개선/회귀 판정: 낮을수록 좋은 지표(overflow, missingTables)는 감소가 개선, 높을수록 좋은 지표
// (svgCoverage, prvCoverage)는 증가가 개선. 작은 노이즈는 무시(임계).
const improved: string[] = [];
const regressed: string[] = [];
for (const [file, a] of after) {
  const b = before.get(file);
  if (!b) continue;
  if (b.ok && !a.ok) { regressed.push(`  ⛔ 로드실패로 회귀: ${base(file)}`); continue; }
  if (!a.ok || !b.ok || a.partial || b.partial) continue;
  const dOvf = (a.htmlMaxOverflowPx ?? 0) - (b.htmlMaxOverflowPx ?? 0);
  const dMiss = (a.svgMissingTables ?? 0) - (b.svgMissingTables ?? 0);
  const dCov = (a.svgCoverage ?? 0) - (b.svgCoverage ?? 0);
  const notes: string[] = [];
  const reg: string[] = [];
  if (dOvf < -50) notes.push(`ovf ${b.htmlMaxOverflowPx}→${a.htmlMaxOverflowPx}`);
  if (dOvf > 50) reg.push(`ovf ${b.htmlMaxOverflowPx}→${a.htmlMaxOverflowPx}`);
  if (dMiss < 0) notes.push(`miss ${b.svgMissingTables}→${a.svgMissingTables}`);
  if (dMiss > 0) reg.push(`miss ${b.svgMissingTables}→${a.svgMissingTables}`);
  if (dCov > 0.02) notes.push(`cov ${b.svgCoverage}→${a.svgCoverage}`);
  if (dCov < -0.02) reg.push(`cov ${b.svgCoverage}→${a.svgCoverage}`);
  if (notes.length) improved.push(`  ✅ ${base(file)}  [${notes.join(", ")}]`);
  if (reg.length) regressed.push(`  ⚠ ${base(file)}  [${reg.join(", ")}]`);
}

console.log(`\n=== 개선 ${improved.length} ===`);
console.log(improved.join("\n") || "  (없음)");
console.log(`\n=== 회귀 ${regressed.length} ===`);
console.log(regressed.join("\n") || "  (없음)");

// 집계
const sum = (m: Map<string, Row>, key: keyof Row, pred: (r: Row) => boolean) =>
  [...m.values()].filter((r) => r.ok && !r.partial && pred(r)).length;
console.log(`\n=== 집계 (before → after) ===`);
console.log(`overflow>200px 파일: ${sum(before,"htmlMaxOverflowPx",r=>(r.htmlMaxOverflowPx??0)>200)} → ${sum(after,"htmlMaxOverflowPx",r=>(r.htmlMaxOverflowPx??0)>200)}`);
console.log(`SVG 표누락 파일:    ${sum(before,"svgMissingTables",r=>(r.svgMissingTables??0)>0)} → ${sum(after,"svgMissingTables",r=>(r.svgMissingTables??0)>0)}`);
console.log(`SVG cov<0.95 파일:  ${sum(before,"svgCoverage",r=>(r.svgCoverage??1)<0.95)} → ${sum(after,"svgCoverage",r=>(r.svgCoverage??1)<0.95)}`);
