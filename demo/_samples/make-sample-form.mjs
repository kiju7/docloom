/**
 * 회의록 docx 샘플 양식 생성기.  실행:  node demo/_samples/make-sample-form.mjs
 *
 * compose 는 docx→html→채움→docx 로 왕복한다. docloom 이 표(w:tbl)를 '편집 가능 표'
 * (editableTables) 로 인코딩하므로 — 원본 표는 보존되고 빈 셀만 LLM 이 채운다 — 격자 양식 그대로
 * 채워서 docx 로 다운로드된다. 라벨 셀은 텍스트가 있어 보존되고, 값 셀은 비워 둬 채움 슬롯이 된다.
 */
import { zipSync, strToU8 } from "fflate";
import { writeFileSync } from "node:fs";

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const para = (text, style) =>
  `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ""}` +
  `${text ? `<w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r>` : ""}</w:p>`;

const BORDERS = (sz = 4) =>
  ["top", "left", "bottom", "right", "insideH", "insideV"]
    .map((s) => `<w:${s} w:val="single" w:sz="${sz}" w:space="0" w:color="AAB1C2"/>`)
    .join("");
const cellBorders = ["top", "left", "bottom", "right"]
  .map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="AAB1C2"/>`)
  .join("");

/** 표 셀. label=true → 회색 배경+굵게, span=가로병합, w=폭(twip) */
const tc = (text, { w = 2256, label = false, span = 1 } = {}) =>
  `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${span > 1 ? `<w:gridSpan w:val="${span}"/>` : ""}` +
  `<w:tcBorders>${cellBorders}</w:tcBorders>${label ? `<w:shd w:val="clear" w:fill="F3F5FB"/>` : ""}` +
  `<w:vAlign w:val="center"/></w:tcPr>` +
  `<w:p>${label ? `<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r>` : (text ? `<w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r>` : "")}</w:p></w:tc>`;
const tr = (cells) => `<w:tr>${cells}</w:tr>`;
const tbl = (cols, rows) =>
  `<w:tbl><w:tblPr><w:tblW w:w="9024" w:type="dxa"/><w:tblBorders>${BORDERS()}</w:tblBorders></w:tblPr>` +
  `<w:tblGrid>${cols.map((w) => `<w:gridCol w:w="${w}"/>`).join("")}</w:tblGrid>${rows.join("")}</w:tbl>`;

// 라벨 칸은 좁게(L), 값(작성) 칸은 넓게(V) — 미리보기/문서 모두 colgroup 비율로 반영된다.
const L = 1300, V = 3212;
const infoTable = tbl(
  [L, V, L, V],
  [
    tr(tc("회의명", { w: L, label: true }) + tc("", { w: V }) + tc("일시", { w: L, label: true }) + tc("", { w: V })),
    tr(tc("장소", { w: L, label: true }) + tc("", { w: V }) + tc("작성자", { w: L, label: true }) + tc("", { w: V })),
    tr(tc("참석자", { w: L, label: true }) + tc("", { w: V + L + V, span: 3 })),
  ],
);
const agendaTable = tbl(
  [700, 2775, 2775, 2774],
  [
    tr(tc("No", { w: 700, label: true }) + tc("안건", { w: 2775, label: true }) + tc("논의 내용", { w: 2775, label: true }) + tc("결정 사항", { w: 2774, label: true })),
    // 데이터 2행만 — 자료가 많으면 LLM 이 행을 자동 확장한다(structuredFill).
    ...[1, 2].map((n) => tr(tc(String(n), { w: 700 }) + tc("", { w: 2775 }) + tc("", { w: 2775 }) + tc("", { w: 2774 }))),
  ],
);
// 액션 아이템 표(업무 내용 | 담당자 | 마감 기한) — 헤더형 표. 행은 자료 수만큼 자동 확장.
const actionTable = tbl(
  [4512, 2256, 2256],
  [
    tr(tc("업무 내용", { w: 4512, label: true }) + tc("담당자", { w: 2256, label: true }) + tc("마감 기한", { w: 2256, label: true })),
    ...[1, 2].map(() => tr(tc("", { w: 4512 }) + tc("", { w: 2256 }) + tc("", { w: 2256 }))),
  ],
);

// 회의록(정보표 + 안건표 + 액션 아이템 표 + 비고). 한 페이지에 맞춘 컴팩트 구성.
// (결정 사항은 안건표의 '결정 사항' 열로 다룬다 — 별도 섹션 제거로 한 페이지 확보.)
const body =
  para("회의록", "Title") +
  infoTable +
  para("안건 및 논의 내용", "Heading1") +
  agendaTable +
  para("향후 일정 및 담당자", "Heading1") +
  actionTable +
  para("특이 사항 / 비고", "Heading1") +
  para("비고: ");

const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`;
const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:pPr><w:jc w:val="center"/><w:spacing w:before="0" w:after="120"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:spacing w:before="120" w:after="40"/></w:pPr><w:rPr><w:b/><w:sz w:val="22"/></w:rPr></w:style></w:styles>`;
const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`;

const zip = zipSync({
  "[Content_Types].xml": strToU8(contentTypes),
  "_rels/.rels": strToU8(rels),
  "word/_rels/document.xml.rels": strToU8(docRels),
  "word/styles.xml": strToU8(styles),
  "word/document.xml": strToU8(documentXml),
});
writeFileSync(new URL("./sample-form.docx", import.meta.url), zip);
console.log("sample-form.docx written:", zip.length, "bytes");
