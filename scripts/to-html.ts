/**
 * docx → 미리보기 HTML 파일 저장 CLI.
 *
 *   npm run html -- <input.docx> [output.html]
 *   예) npm run html -- test/fixtures/sample.docx out.html
 *
 * output 을 생략하면 input 과 같은 이름의 .html 로 저장한다.
 * 저장된 파일을 브라우저로 열면 양식 미리보기가 보인다.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { docxToPreviewHtml } from "../src/index.js";

const [, , input, output] = process.argv;
if (!input) {
  console.error("사용법: npm run html -- <input.docx> [output.html]");
  process.exit(1);
}

const outPath = output ?? input.replace(/\.docx$/i, "") + ".html";
const docx = new Uint8Array(readFileSync(input));
const html = docxToPreviewHtml(docx, { title: basename(input) });
writeFileSync(outPath, html, "utf8");

console.log(`✓ ${input} → ${outPath}`);
console.log(`  브라우저로 열어서 미리보기:  open ${outPath}`);
