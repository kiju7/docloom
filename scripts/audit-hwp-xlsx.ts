/** HWP/HWPX(rhwp 편집 경로) + xlsx/csv/md 왕복 감사. */
import { readFileSync, readdirSync } from "node:fs";
import { loadRhwp } from "./rhwpNode.js";
import { hwpToEditableHtml, applyHwpEdits } from "../src/rhwp/hwpEdit.js";
import { encode, decode } from "../src/registry.js";

const MARK = "★감사마커★";
const Ctor = (await loadRhwp())!;

function textOf(h: string) { return h.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim(); }

async function auditHwp(label: string, path: string) {
  console.log(`\n■ ${label}`);
  let doc: any;
  try { doc = new Ctor(new Uint8Array(readFileSync(path))); }
  catch (e) { console.log(`  ❌ 로드 실패: ${String(e).slice(0, 150)}`); return; }
  let html: string;
  try { html = hwpToEditableHtml(doc); }
  catch (e) { console.log(`  ❌ hwpToEditableHtml 실패: ${String(e).slice(0, 150)}`); return; }
  const text0 = textOf(html);
  console.log(`  편집 HTML ${html.length}B, 텍스트 ${text0.length}자`);
  // 평문 문단(data-h) 또는 셀(data-hc) 텍스트 편집
  const m = html.match(/data-h[cp]?="[^"]*"[^>]*>([^<>]{4,}?)</) || html.match(/<p data-h="[^"]*">([^<>]{4,}?)</);
  if (!m) { console.log(`  ⚠ 편집 가능한 텍스트 토막 없음`); return; }
  const t = m[1];
  const edited = html.replace(`>${t}<`, `>${t}${MARK}<`);
  let n = 0;
  try { n = applyHwpEdits(doc, edited); }
  catch (e) { console.log(`  ❌ applyHwpEdits 실패: ${String(e).slice(0, 150)}`); return; }
  let out: Uint8Array;
  try { out = doc.exportHwpx(); }
  catch (e) { console.log(`  ❌ exportHwpx 실패: ${String(e).slice(0, 150)}`); return; }
  let doc2: any, kept = false, text2 = 0;
  try {
    doc2 = new Ctor(out);
    const h2 = hwpToEditableHtml(doc2);
    kept = h2.includes(MARK);
    text2 = textOf(h2).length;
  } catch (e) { console.log(`  ❌ 복원물 재로드 실패: ${String(e).slice(0, 150)}`); return; }
  console.log(`  편집 "${t.slice(0,20)}" ${n}곳 → exportHwpx ${(out.length/1024).toFixed(0)}KB`);
  console.log(`  복원물 텍스트 ${text2}자, 보존율 ${((text2/Math.max(1,text0.length))*100).toFixed(0)}%`);
  console.log(`  ${kept ? "✅ 편집 마커 생존(.hwpx 복원)" : "❌ 편집 마커 소실"}`);
}

async function auditGeneric(label: string, bytes: Uint8Array, fmt: any) {
  console.log(`\n■ ${label}`);
  let enc: any;
  try { enc = encode(bytes, { format: fmt }); }
  catch (e) { console.log(`  ❌ encode 실패: ${String(e).slice(0,150)}`); return; }
  const text0 = textOf(enc.html);
  console.log(`  encode HTML ${enc.html.length}B, 텍스트 ${text0.length}자`);
  const m = enc.html.match(/data-[a-z-]+="[^"]*"[^>]*>([^<>]*[가-힣A-Za-z0-9][^<>]{2,}?)</) || enc.html.match(/>([^<>]*[가-힣A-Za-z0-9][^<>]{3,}?)</);
  if (!m) { console.log(`  ⚠ 편집 토막 없음`); return; }
  const t = m[1];
  const edited = enc.html.replace(`>${t}<`, `>${t}${MARK}<`);
  let b2: Uint8Array;
  try { b2 = decode(edited, enc.manifest, { format: fmt }); }
  catch (e) { console.log(`  ❌ decode 실패: ${String(e).slice(0,200)}`); return; }
  let enc2: any;
  try { enc2 = encode(b2, { format: fmt }); }
  catch (e) { console.log(`  ❌ 재encode 실패: ${String(e).slice(0,150)}`); return; }
  const kept = enc2.html.includes(MARK);
  console.log(`  편집 "${t.slice(0,20)}" → decode ${(b2.length/1024).toFixed(0)}KB`);
  console.log(`  ${kept ? "✅ 편집 마커 생존" : "❌ 편집 마커 소실"}`);
}

const ROOT = "/Users/jd-kimkiju/Desktop/test_sample";
// HWPX 1개 + HWP 1개
await auditHwp("hwpx (document.hwpx)", `${ROOT}/hwpx/document.hwpx`);
await auditHwp("hwp (sample.hwp 픽스처)", "test/fixtures/sample.hwp");
const firstHwp = readdirSync(`${ROOT}/hwp`).filter(f=>f.endsWith(".hwp"))[0];
await auditHwp(`hwp (${firstHwp.slice(0,24)})`, `${ROOT}/hwp/${firstHwp}`);

// CSV/MD 합성
const csv = new TextEncoder().encode("이름,점수,비고\n홍길동,90,우수\n김철수,85,보통\n");
await auditGeneric("csv (합성)", csv, "csv");
const md = new TextEncoder().encode("# 제목\n\n본문 문단입니다.\n\n- 항목 하나\n- 항목 둘\n");
await auditGeneric("md (합성)", md, "md");

console.log("\n— HWP/xlsx 감사 완료 —");
