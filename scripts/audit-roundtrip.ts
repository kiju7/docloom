/**
 * 포맷별 편집-복원 왕복 감사.
 * 각 포맷: encode(bytes)->{html,manifest} -> 보이는 텍스트 1곳에 마커 삽입(LLM 편집 흉내)
 *   -> decode(editedHtml,manifest)->bytes2 -> encode(bytes2) 재추출 -> 마커 생존 & 본문 보존 확인.
 */
import { readFileSync } from "node:fs";
import { encode, decode, adapterFor } from "../src/registry.js";

const MARK = "★감사마커★";

// 편집 채널(decode 가 읽는 매핑된 요소) 내부 텍스트에 마커를 덧붙인다.
// 합성 라벨(슬라이드번호 등 data-* 없는 요소)을 피하려고 data-run/data-cell/data-para 를 우선한다.
function editFirstText(html: string): { edited: string; target: string } | null {
  const editors = [
    // pptx/ppt: <span data-run="..">텍스트</span>, 셀: data-cell
    /data-(?:run|cell)="[^"]*"[^>]*>([^<>]*?[가-힣A-Za-z0-9][^<>]{3,}?)</g,
    // docx/hwpx 등 일반: data-* 가진 요소 직속 텍스트
    /data-[a-z-]+="[^"]*"[^>]*>([^<>]*?[가-힣A-Za-z0-9][^<>]{3,}?)</g,
    // 폴백: 아무 보이는 텍스트
    />([^<>]*?[가-힣A-Za-z0-9][^<>]{5,}?)</g,
  ];
  for (const re of editors) {
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(html))) {
      const t = m[1];
      if (t.includes(MARK)) continue;
      if (!/[가-힣A-Za-z0-9]/.test(t)) continue;
      const idx = html.indexOf(`>${t}<`);
      if (idx < 0) continue;
      const edited = html.slice(0, idx) + `>${t}${MARK}<` + html.slice(idx + t.length + 2);
      return { edited, target: t.trim().slice(0, 30) };
    }
  }
  return null;
}

function textOf(html: string): string {
  return html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

async function auditOne(label: string, path: string) {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(readFileSync(path));
  } catch (e) {
    console.log(`\n■ ${label}\n  ⚠ 파일 없음: ${path}`);
    return;
  }
  console.log(`\n■ ${label}  (${(bytes.length / 1024).toFixed(0)}KB)`);
  let ad: any;
  try {
    ad = adapterFor(bytes);
  } catch (e) {
    console.log(`  ❌ adapterFor 실패: ${String(e).slice(0, 120)}`);
    return;
  }
  console.log(`  판별 포맷: ${ad.id}  supportsRoundTrip=${ad.supportsRoundTrip}`);
  if (!ad.supportsRoundTrip) {
    console.log(`  · 왕복 미지원(미리보기 전용) — 편집-복원 대상 아님`);
    return;
  }
  let enc: any;
  try {
    enc = encode(bytes, { format: ad.id });
  } catch (e) {
    console.log(`  ❌ encode 실패: ${String(e).slice(0, 200)}`);
    return;
  }
  const html0 = enc.html;
  const text0 = textOf(html0);
  console.log(`  encode HTML ${html0.length}B, 추출 텍스트 ${text0.length}자`);
  const ed = editFirstText(html0);
  if (!ed) {
    console.log(`  ⚠ 편집할 텍스트 토막을 못 찾음(이미지/표만?) — 마커 왕복 생략`);
    return;
  }
  console.log(`  편집 대상: "${ed.target}" 에 마커 삽입`);
  let bytes2: Uint8Array;
  try {
    bytes2 = decode(ed.edited, enc.manifest, { format: ad.id });
  } catch (e) {
    console.log(`  ❌ decode 실패: ${String(e).slice(0, 300)}`);
    return;
  }
  console.log(`  decode → ${(bytes2.length / 1024).toFixed(0)}KB`);
  // 재추출로 마커 생존 + 텍스트 보존 확인
  let enc2: any;
  try {
    enc2 = encode(bytes2, { format: ad.id });
  } catch (e) {
    console.log(`  ❌ 재encode 실패(복원물 깨짐 가능): ${String(e).slice(0, 200)}`);
    return;
  }
  const text2 = textOf(enc2.html);
  const markOk = enc2.html.includes(MARK) || text2.includes(MARK);
  // 보존율: 원본 텍스트에서 마커 뺀 길이 대비 복원 텍스트 길이
  const keepRatio = text0.length ? text2.replace(MARK, "").length / text0.length : 1;
  console.log(`  복원물 재추출 텍스트 ${text2.length}자, 보존율 ${(keepRatio * 100).toFixed(0)}%`);
  console.log(`  ${markOk ? "✅ 편집 마커 생존" : "❌ 편집 마커 소실"}`);
  if (keepRatio < 0.9) console.log(`  ⚠ 본문 보존율 90% 미만 — 내용 손실 의심`);
}

const ROOT = "/Users/jd-kimkiju/Desktop/test_sample";
const cases: [string, string][] = [
  ["docx", `${ROOT}/docx/default.docx`],
  ["doc", `${ROOT}/doc/test.doc`],
  ["pptx", `${ROOT}/pptx/test.pptx`],
  ["ppt", `${ROOT}/ppt/test.ppt`],
  ["html", `${ROOT}/html/test.html`],
  ["rtf", `${ROOT}/rtf/test.rtf`],
  // 픽스처(데스크탑에 xlsx/csv 없음)
  ["docx(fixture)", "test/fixtures/sample.docx"],
];

for (const [label, p] of cases) await auditOne(label, p);
console.log("\n— 감사 완료 —");
