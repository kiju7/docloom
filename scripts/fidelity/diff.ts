/**
 * 충실도 스코어보드 회귀 게이트 — baseline 대비 개선/회귀를 파일·차원 단위로 보여준다.
 * 엔진(rhwp Rust)이나 렌더러(TS) 수정 후 `npm run fidelity` 재실행 → 이걸로 비교:
 *   tsx scripts/fidelity/diff.ts [baseline.json] [current.json]
 * 개선(score↓)만 있고 회귀(score↑/신규결함)가 0 일 때만 변경을 채택하는 게 원칙.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

interface Finding { dim: string; severity: string; count: number; detail: string }
interface Row { name: string; fmt: string; score: number; error?: string; findings: Finding[] }
interface Board { build: string; rows: Row[] }

const SB = join(process.cwd(), "scoreboards");
const a = JSON.parse(readFileSync(process.argv[2] ?? join(SB, "fidelity-baseline.json"), "utf8")) as Board;
const b = JSON.parse(readFileSync(process.argv[3] ?? join(SB, "fidelity.json"), "utf8")) as Board;

const byName = (rows: Row[]): Map<string, Row> => new Map(rows.map((r) => [r.name, r]));
const A = byName(a.rows), B = byName(b.rows);
const dims = (r?: Row): string => r ? r.findings.map((f) => `${f.dim}×${f.count}`).join(",") || "clean" : "(없음)";

let improved = 0, regressed = 0, neww = 0, fixed = 0;
const lines: string[] = [];
for (const name of new Set([...A.keys(), ...B.keys()])) {
  const ra = A.get(name), rb = B.get(name);
  const sa = ra?.score ?? 0, sb = rb?.score ?? 0;
  if (sa === sb && dims(ra) === dims(rb)) continue;
  if (!ra && rb && sb > 0) { neww++; lines.push(`  ＋신규결함 ${name}: ${dims(rb)}`); continue; }
  if (ra && !rb) { lines.push(`  ?사라진파일 ${name}`); continue; }
  if (sb < sa) { improved++; if (sb === 0) fixed++; lines.push(`  ↓개선 ${name}: ${sa}→${sb} [${dims(ra)} → ${dims(rb)}]`); }
  else if (sb > sa) { regressed++; lines.push(`  ↑회귀 ${name}: ${sa}→${sb} [${dims(ra)} → ${dims(rb)}]`); }
  else { lines.push(`  ~변동 ${name}: [${dims(ra)} → ${dims(rb)}]`); }
}

console.log(`baseline build ${a.build.slice(0, 12)} → current ${b.build.slice(0, 12)}`);
console.log(lines.sort().join("\n") || "  (변화 없음)");
console.log(`\n개선 ${improved}(완전해결 ${fixed}) · 회귀 ${regressed} · 신규결함 ${neww}`);
if (regressed > 0 || neww > 0) { console.log("\n⚠ 회귀/신규결함 있음 — 변경 재검토 권장."); process.exit(1); }
console.log("\n✓ 회귀 없음.");
