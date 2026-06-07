/**
 * 스코어보드 → 스크롤 가능한 HTML 리포트.
 * 177개 파일을 일일이 열지 않고, 결함 큰 순으로 정렬된 한 페이지에서 훑는다.
 * Track 2(시각 diff) 정답지가 있는 파일은 미리보기↔정답 썸네일을 나란히 보여준다.
 */
import type { Finding } from "./oracles.js";

export interface ReportRow {
  name: string; fmt: string; sizeMB: number; ms: number;
  pages?: number; error?: string;
  findings: Finding[];
  score: number;
  visual?: { pages: number; medianSsim: number; worstSsim: number; failPages: number; flow: boolean; thumbs: string[] }; // Track 2
}

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const SEV_COLOR: Record<string, string> = { high: "#c0392b", med: "#d68910", low: "#7f8c8d" };

export function buildReport(rows: ReportRow[], meta: { dir: string; build: string; when: string }): string {
  // ⚠ hwp/hwpx 미리보기는 의도적 *흐름(읽기순서) 레이아웃* — 고정 PDF 와 픽셀 SSIM 이
  // 잘 렌더돼도 구조적으로 낮게 나온다(카테고리 불일치). 그래서 흐름 포맷의 SSIM 은 결함으로
  // 치지 않고 "참고용"으로만 표시한다. docx/pdf/pptx/xlsx 등 레이아웃충실 미리보기만 진짜 게이트.
  // 시각결과가 있으면 그 flow 플래그(충실렌더=false=게이트)를 따르고, 없으면 fmt 로 추정.
  const isFlow = (r: ReportRow): boolean => r.visual ? r.visual.flow : (r.fmt === "hwp" || r.fmt === "hwpx");
  // 정렬·강조 키 = 구조점수 + 시각 패널티(레이아웃충실 포맷만). Track1 score 자체는 오염 안 함.
  const visPenalty = (r: ReportRow): number =>
    !isFlow(r) && r.visual && r.visual.medianSsim < 0.95 ? Math.round((0.95 - r.visual.medianSsim) * 1000) : 0;
  const sortKey = (r: ReportRow): number => r.score + visPenalty(r);
  const isBad = (r: ReportRow): boolean =>
    r.score > 0 || !!r.error || (!isFlow(r) && !!r.visual && r.visual.medianSsim < 0.85);
  const sorted = [...rows].sort((a, b) => sortKey(b) - sortKey(a));
  // 정직한 분리: 구조결함(Track1=진짜 누락) vs 시각 검토대상(SSIM 트리아지, 결함 아닐 수 있음).
  const structIssues = rows.filter((r) => r.score > 0 || r.error).length;
  const visualReview = rows.filter((r) => r.score === 0 && !r.error && !isFlow(r) && r.visual && r.visual.medianSsim < 0.85).length;
  const byDim = new Map<string, number>();
  for (const r of rows) for (const f of r.findings) byDim.set(f.dim, (byDim.get(f.dim) ?? 0) + 1);
  const dimSummary = [...byDim.entries()].sort((a, b) => b[1] - a[1])
    .map(([d, n]) => `<span class="pill">${esc(d)} <b>${n}</b></span>`).join(" ");

  const rowsHtml = sorted.map((r, i) => {
    const fnd = r.findings.map((f) =>
      `<div class="f" style="border-left:3px solid ${SEV_COLOR[f.severity]}">
         <span class="dim">${esc(f.dim)}</span>
         <span class="sev" style="color:${SEV_COLOR[f.severity]}">${f.severity}</span>
         <span class="det">${esc(f.detail)}</span></div>`).join("");
    const vis = r.visual ? visualBlock(r.visual, isFlow(r)) : "";
    const visLow = !isFlow(r) && r.visual && r.visual.medianSsim < 0.85;
    const badge = r.error ? `<span class="err">ERROR</span>`
      : r.score > 0 ? `<span class="warn">${r.findings.length}건 · score ${r.score}</span>`
      : visLow ? `<span class="warn">시각 중앙SSIM ${r.visual!.medianSsim.toFixed(2)}</span>`
      : `<span class="ok">clean</span>`;
    return `<tr class="${isBad(r) ? "bad" : "good"}">
      <td class="idx">${i + 1}</td>
      <td class="nm">${esc(r.name)}</td>
      <td><span class="fmt">${esc(r.fmt)}</span></td>
      <td class="num">${r.pages ?? "-"}</td>
      <td class="num">${r.sizeMB}MB</td>
      <td>${badge}</td>
      <td class="findings">${r.error ? `<div class="f" style="border-left:3px solid ${SEV_COLOR.high}"><span class="det">${esc(r.error)}</span></div>` : fnd}${vis}</td>
    </tr>`;
  }).join("\n");

  return `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<title>docloom 충실도 리포트 (${rows.length}파일)</title>
<style>
  body{font:13px/1.5 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo",sans-serif;margin:0;background:#f4f5f7;color:#1a1a1a}
  header{position:sticky;top:0;background:#fff;border-bottom:1px solid #ddd;padding:14px 20px;z-index:5;box-shadow:0 1px 4px rgba(0,0,0,.05)}
  h1{font-size:17px;margin:0 0 6px}
  .meta{color:#666;font-size:12px}
  .pills{margin-top:8px}
  .pill{display:inline-block;background:#eef0f3;border-radius:12px;padding:2px 10px;margin:2px 4px 2px 0;font-size:12px}
  .pill b{color:#c0392b}
  table{border-collapse:collapse;width:100%;background:#fff}
  th,td{padding:8px 10px;border-bottom:1px solid #eee;vertical-align:top;text-align:left}
  th{position:sticky;top:64px;background:#fafbfc;font-size:12px;color:#555;z-index:4}
  tr.good{opacity:.6}
  td.idx{color:#aaa;font-variant-numeric:tabular-nums}
  td.nm{font-weight:600;max-width:280px;word-break:break-all}
  td.num{text-align:right;font-variant-numeric:tabular-nums;color:#555;white-space:nowrap}
  .fmt{background:#eaf2fb;color:#2c6fbf;border-radius:4px;padding:1px 7px;font-size:11px;font-weight:600}
  .ok{color:#27ae60;font-weight:600}.warn{color:#d68910;font-weight:600;white-space:nowrap}.err{color:#c0392b;font-weight:700}
  .f{padding:4px 8px;margin:3px 0;background:#fbfbfb;border-radius:0 4px 4px 0;font-size:12px}
  .dim{font-weight:700;margin-right:6px}.sev{font-size:11px;text-transform:uppercase;margin-right:6px}
  .det{color:#444}
  .vis{display:flex;gap:8px;margin-top:6px;flex-wrap:wrap}
  .vis figure{margin:0;text-align:center}.vis img{height:180px;border:1px solid #ccc;border-radius:3px;background:#fff}
  .vis figcaption{font-size:11px;color:#777}
  .filter{margin-top:8px}.filter input{padding:4px 8px;border:1px solid #ccc;border-radius:5px;width:240px}
</style></head><body>
<header>
  <h1>docloom 충실도 리포트 — 구조결함 <b style="color:#c0392b">${structIssues}</b> · 시각 검토대상 <b style="color:#d68910">${visualReview}</b> / ${rows.length}파일</h1>
  <div class="meta" style="margin-top:2px">구조결함=데이터에 있는 개체가 출력에서 누락(신뢰). 시각 검토대상=정답 PDF 대비 SSIM 낮음(트리아지 — 썸네일로 눈 확인, reflow·폰트차로 결함 아닐 수 있음). hwp 는 충실렌더 기준.</div>
  <div class="meta">코퍼스: ${esc(meta.dir)} · rhwp ${esc(meta.build.slice(0, 12))} · ${esc(meta.when)}</div>
  <div class="pills">${dimSummary || "<span class=pill>결함 없음</span>"}</div>
  <div class="filter"><input id="q" placeholder="파일명 필터…" oninput="filt()"></div>
</header>
<table>
  <thead><tr><th>#</th><th>파일</th><th>fmt</th><th>쪽</th><th>크기</th><th>판정</th><th>결함</th></tr></thead>
  <tbody id="tb">${rowsHtml}</tbody>
</table>
<script>
function filt(){var q=document.getElementById('q').value.toLowerCase();
  for(var tr of document.querySelectorAll('#tb tr')){
    var nm=tr.querySelector('.nm').textContent.toLowerCase();
    tr.style.display=nm.includes(q)?'':'none';}}
</script>
</body></html>`;
}

function visualBlock(v: NonNullable<ReportRow["visual"]>, flow: boolean): string {
  const thumbs = v.thumbs.map((t, i) =>
    `<figure><img src="${esc(t)}" loading="lazy"><figcaption>p${i + 1}</figcaption></figure>`).join("");
  if (flow) {
    // 흐름 미리보기(hwp/hwpx) — 픽셀 SSIM 은 카테고리 불일치라 결함 신호 아님. 썸네일만 참고.
    return `<div class="f" style="border-left:3px solid #95a5a6;background:#f7f8f9">
      <span class="dim">visual</span><span class="sev" style="color:#7f8c8d">참고</span>
      <span class="det">흐름 미리보기 — PDF 와 픽셀비교 부적합(점수아님). 좌:미리보기 우:원본 눈으로 대조.</span>
      <div class="vis">${thumbs}</div></div>`;
  }
  const verdict = v.medianSsim >= 0.9 ? "ok" : v.medianSsim >= 0.8 ? "warn" : "err";
  return `<div class="f" style="border-left:3px solid ${verdict === "ok" ? "#27ae60" : verdict === "warn" ? "#d68910" : "#c0392b"}">
    <span class="dim">visual</span>
    <span class="det">중앙 SSIM ${v.medianSsim.toFixed(3)} (최저 ${v.worstSsim.toFixed(3)}, ${v.pages}쪽) · ${v.failPages}쪽 차이큼 — 썸네일 확인</span>
    <div class="vis">${thumbs}</div></div>`;
}
