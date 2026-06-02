import { readFileSync } from "node:fs";
import { loadRhwp } from "./rhwpNode.js";
import { hwpToEditableHtml, applyHwpEdits } from "../src/rhwp/hwpEdit.js";
const Ctor = (await loadRhwp())!;
const F = process.argv[2]!;
const doc: any = new Ctor(new Uint8Array(readFileSync(F)));
const html = hwpToEditableHtml(doc);
const hcp = (html.match(/data-hcp="/g) || []).length;
const nestedTbl = (html.match(/data-htp="/g) || []).length;
console.log(`중첩표 <table data-htp>=${nestedTbl}, 중첩 셀 앵커 data-hcp=${hcp}`);
if (hcp === 0) { console.log("중첩표 없음 — round-trip 테스트 스킵"); process.exit(0); }
// 첫 비어있지 않은 중첩 셀 텍스트를 골라 마커 추가
const m = html.match(/<div data-hcp="([^"]+)">([^<]+)<\/div>/);
if (!m) { console.log("편집할 중첩 셀 텍스트 없음(빈 셀만)"); process.exit(0); }
const [, anchor, orig] = m;
const marker = orig + "★중첩편집";
const edited = html.replace(`data-hcp="${anchor}">${orig}</div>`, `data-hcp="${anchor}">${marker}</div>`);
console.log(`편집 대상 중첩셀: "${orig!.slice(0,20)}" → "+★중첩편집"`);
const n = applyHwpEdits(doc, edited);
console.log(`applyHwpEdits 변경=${n}`);
const out = doc.exportHwpx();
console.log(`exportHwpx 바이트=${out.length}`);
// 재로드 → 마커 확인
const doc2: any = new Ctor(out);
const html2 = hwpToEditableHtml(doc2);
console.log(html2.includes("★중첩편집") ? "✅ 라운드트립 성공 — 중첩표 편집이 .hwpx 복원물에 반영됨" : "❌ 라운드트립 실패 — 마커 없음");
