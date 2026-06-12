/**
 * Track 1 — 구조 누락 오라클 (정답지 불필요).
 *
 * 핵심 아이디어: "원본과 픽셀이 같은가"는 한글 앱 ground-truth 없이 자동검증 불가지만,
 * **데이터 모델에 있는 개체가 출력 HTML 에서 조용히 사라졌는가**는 구조적 불변식이라
 * 100% 자동으로 잡힌다. 사용자 불만(개체/표/특수기호 누락)을 정확히 겨냥한다.
 *
 * rhwp(hwp/hwpx)는 풍부한 데이터 API 가 있어 표/셀/이미지/특수기호/머리말꼬리말 드롭을
 * 모두 본다. 그 외 포맷은 독립적 소스 모델이 없어 렌더 실패/빈출력만 보고(객체 드롭은
 * Track 2 시각 diff 가 담당) — 이 분담은 정직한 한계다.
 */
import { specialSymbolCounts, htmlToVisibleText } from "./symbols.js";
import type { Rendered, RhwpDocFull } from "./render.js";

export type Severity = "high" | "med" | "low";
export interface Finding { dim: string; severity: Severity; count: number; detail: string }

const safe = <T,>(fn: () => T): T | undefined => { try { return fn(); } catch { return undefined; } };
const pj = <T = any,>(s: string | undefined): T | null => {
  if (typeof s !== "string") return null;
  try { return JSON.parse(s) as T; } catch { return null; }
};
const strip = (s: string): string => s.replace(/\s+/g, "");

/** 한 문서의 본문+셀 정답 텍스트, 표별 지문(가장 긴 셀), 실제 그림 수, 머리말꼬리말. */
interface Truth { text: string; tableProbes: string[]; imageNodes: number; hf: string[] }

function sectionCount(doc: RhwpDocFull): number {
  const info = pj<{ sectionCount?: number }>(safe(() => doc.getDocumentInfo()));
  return Math.max(1, info?.sectionCount ?? 1);
}

// 표의 가장 긴 셀 문단에서 뽑은 **분별력 있는 짧은 접두**(표 렌더 여부 지문).
// ⚠ 예전엔 최장 문단 전체(수백 자)를 연속 부분문자열로 검사했는데, 셀의 긴 문단이 본문의
//   유사 구절과 헷갈리거나 셀 문단 분절 순서가 data-API 와 달라 **거짓양성**이 났다(KKITS:
//   표 텍스트가 다 렌더됐는데도 260자 연속매칭 실패). 짧고 분별력 있는 접두만 보면 진짜
//   드롭(접두조차 부재)은 잡고 분절 차이 거짓양성은 사라진다. (28자 한글/영문은 충분히 고유.)
const PROBE_LEN = 28;
function longestCellProbe(doc: RhwpDocFull, s: number, p: number, ci: number): string {
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
  return best.slice(0, PROBE_LEN);
}

/** 한 페이지의 **실제 그림 수** — rhwp 가 한 그림을 stepping 좌표로 여러 번 토하므로,
 *  렌더 트리 Image 노드를 세면 과대계상된다. 권위 있는 출처인 getPageControlLayout 의
 *  image 컨트롤을 **고유 식별자 (secIdx,paraIdx,controlIdx)** 로 중복 제거해 센다
 *  (미리보기 buildPageImages 와 동일 키 — 검증과 렌더가 같은 진실을 본다). */
function pageImageCount(doc: RhwpDocFull, pg: number): number {
  const cl = pj<{ controls?: any[] }>(safe(() => doc.getPageControlLayout?.(pg)));
  if (!cl) return 0;
  const ids = new Set<string>();
  for (const c of cl.controls ?? []) {
    // 식별자가 불완전(undefined)한 컨트롤은 신뢰 불가(추출·dedup 불가) → 세지 않는다(미리보기와 동일).
    if (c?.type === "image" && typeof c.secIdx === "number" && typeof c.paraIdx === "number" && typeof c.controlIdx === "number") {
      ids.add(`${c.secIdx},${c.paraIdx},${c.controlIdx}`);
    }
  }
  return ids.size;
}

function extractTruth(doc: RhwpDocFull): Truth {
  const secN = sectionCount(doc);
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
  // 실제 그림 수 = 컨트롤 식별자(secIdx,paraIdx,controlIdx) 고유 개수(미리보기와 동일 진실).
  let imageNodes = 0;
  const pageN = safe(() => doc.pageCount()) ?? 0;
  for (let i = 0; i < pageN; i++) imageNodes += pageImageCount(doc, i);
  // 머리말/꼬리말 텍스트 — getHeaderFooter 는 JSON 봉투 {ok,exists,text,paraIndex,controlIndex}.
  // collectHfBlocks 와 동일하게 exists 확인 + (isHeader|paraIndex|controlIndex) 중복제거 + 빈 HF 제외.
  const hf: string[] = [];
  const seen = new Set<string>();
  for (let s = 0; s < secN; s++) {
    for (const isH of [true, false]) {
      for (const applyTo of [0, 1, 2]) {
        const j = pj<{ exists?: boolean; text?: string; paraIndex?: number; controlIndex?: number }>(
          safe(() => doc.getHeaderFooter?.(s, isH, applyTo)));
        if (!j || !j.exists) continue;
        const key = `${isH}|${j.paraIndex ?? -1}|${j.controlIndex ?? -1}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const t = typeof j.text === "string" ? j.text : "";
        if (strip(t).length >= 2) hf.push(t);
      }
    }
  }
  return { text, tableProbes, imageNodes, hf };
}

/** rhwp(hwp/hwpx) 구조 오라클: 출력 HTML 을 데이터 모델과 대조. */
export function rhwpOracles(doc: RhwpDocFull, html: string): Finding[] {
  const findings: Finding[] = [];
  const truth = extractTruth(doc);
  // 각주 마커(<sup class="hp-fn">1)</sup>)는 렌더가 합성한 번호로 데이터모델 셀텍스트엔
  // 없다. 이게 본문/셀 글자 사이에 끼면 연속-부분문자열 표지문 매칭을 깨뜨려 거짓 누락이
  // 난다(예: "우수빈,박승희" 가 "우수빈1),박승희" 로). 표지문 매칭 전에 제거한다.
  const cleanHtml = html.replace(/<sup class="hp-fn">[^<]*<\/sup>/g, "");
  const vis = htmlToVisibleText(cleanHtml);
  const visStrip = strip(vis);

  // ① 특수기호 누락 — 원본 기호 중 렌더 출력에 아예 없는 것(가장 직접적인 불만)
  const srcSym = specialSymbolCounts(truth.text);
  const outSym = specialSymbolCounts(vis);
  const dropped: string[] = [];
  for (const [ch] of srcSym) if (!outSym.has(ch)) dropped.push(ch);
  if (dropped.length) {
    findings.push({
      dim: "symbols", severity: "high", count: dropped.length,
      detail: `누락 기호: ${dropped.slice(0, 30).join(" ")}${dropped.length > 30 ? " …" : ""}`,
    });
  }

  // ② 표 누락 — 각 표의 가장 긴 셀 텍스트가 출력에 연속 부분문자열로 있나
  const missTables = truth.tableProbes.filter((pr) => !visStrip.includes(pr));
  if (missTables.length) {
    findings.push({
      dim: "tables", severity: "high", count: missTables.length,
      detail: `${missTables.length}/${truth.tableProbes.length} 표 셀텍스트 누락 (예: "${missTables[0]!.slice(0, 24)}")`,
    });
  }

  // ③ 이미지 누락 — 트리 Image 노드 수 vs 출력 <img> 수
  const outImg = (html.match(/<img\b/gi) ?? []).length;
  if (truth.imageNodes > outImg) {
    findings.push({
      dim: "images", severity: outImg === 0 && truth.imageNodes > 0 ? "high" : "med",
      count: truth.imageNodes - outImg,
      detail: `실제 그림 ${truth.imageNodes}개 중 출력 <img> ${outImg}개 (${truth.imageNodes - outImg}개 누락)`,
    });
  }

  // ④ 머리말/꼬리말 누락
  const missHf = truth.hf.filter((t) => !visStrip.includes(strip(t)));
  if (missHf.length) {
    findings.push({
      dim: "headerFooter", severity: "med", count: missHf.length,
      detail: `머리말/꼬리말 ${missHf.length}개 누락 (예: "${missHf[0]!.slice(0, 24)}")`,
    });
  }

  // ⑤ 본문 텍스트 커버리지(보조 신호) — 같은 데이터원이라 정상이면 높음. 낮으면 실드롭.
  const cov = coverage(strip(truth.text), visStrip);
  if (truth.text.length > 50 && cov < 0.9) {
    findings.push({
      dim: "textCoverage", severity: cov < 0.6 ? "high" : "med", count: Math.round((1 - cov) * 100),
      detail: `본문 글자 커버리지 ${(cov * 100).toFixed(1)}% (정답 ${strip(truth.text).length}자)`,
    });
  }
  return findings;
}

/** 비-rhwp 포맷: 독립 소스모델이 없어 렌더 실패/빈출력만 본다(개체 드롭은 Track 2). */
export function genericOracles(r: Rendered): Finding[] {
  const findings: Finding[] = [];
  if (r.error) {
    findings.push({ dim: "render", severity: "high", count: 1, detail: r.error });
    return findings;
  }
  const vis = strip(htmlToVisibleText(r.html));
  // 빈 출력(텍스트도 이미지도 없음) = 사실상 렌더 실패
  const imgs = (r.html.match(/<img\b/gi) ?? []).length;
  if (vis.length < 5 && imgs === 0) {
    findings.push({ dim: "render", severity: "high", count: 1, detail: `빈 미리보기(텍스트 ${vis.length}자, 이미지 0)` });
  }
  return findings;
}

/** truth 글자 멀티셋이 cand 에 얼마나 덮이나. [0,1]. */
function coverage(truth: string, cand: string): number {
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
