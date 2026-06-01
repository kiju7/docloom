/**
 * xlsx 왕복(encode → 편집 → decode) — 셀 텍스트 편집 후 서식·병합·스타일 보존 검증.
 */
import { describe, it, expect } from "vitest";
import { zipSync, unzipSync, strToU8, strFromU8 } from "fflate";
import { encodeXlsxToHtml } from "../src/encode/xlsxToHtml.js";
import { decodeHtmlToXlsx } from "../src/decode/htmlToXlsx.js";

function buildXlsx(): Uint8Array {
  const shared = ["제목", "이름", "금액", "홍길동"];
  const sst = `<sst xmlns="x" count="${shared.length}">${shared.map((s) => `<si><t>${s}</t></si>`).join("")}</sst>`;
  const styles = `<styleSheet xmlns="x">
    <fonts count="2"><font/><font><b/><color rgb="FFFF0000"/></font></fonts>
    <fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>
      <fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/></patternFill></fill></fills>
    <cellXfs count="2"><xf/><xf fontId="1" fillId="2" applyFont="1" applyFill="1"/></cellXfs>
  </styleSheet>`;
  // A1: 공유문자열 "제목"(s=1, 빨강볼드+노랑배경) — 편집 안 함(스타일 보존 확인용)
  // A2: 공유문자열 "이름"(s=1) — 이걸 편집한다
  // C3: 숫자 100 (스타일 없음) — 손 안 댐
  const sheet = `<worksheet xmlns="x"><dimension ref="A1:C3"/>
    <sheetData>
      <row r="1"><c r="A1" s="1" t="s"><v>0</v></c></row>
      <row r="2"><c r="A2" s="1" t="s"><v>1</v></c><c r="C2" t="s"><v>2</v></c></row>
      <row r="3"><c r="A3" t="s"><v>3</v></c><c r="C3"><v>100</v></c></row>
    </sheetData>
    <mergeCells count="1"><mergeCell ref="A1:C1"/></mergeCells>
  </worksheet>`;
  return zipSync({
    "[Content_Types].xml": strToU8(`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>`),
    "xl/workbook.xml": strToU8(`<workbook xmlns="x"><sheets><sheet name="요약"/></sheets></workbook>`),
    "xl/sharedStrings.xml": strToU8(sst),
    "xl/styles.xml": strToU8(styles),
    "xl/worksheets/sheet1.xml": strToU8(sheet),
  });
}

describe("xlsx 왕복", () => {
  it("셀 텍스트를 편집해도 스타일(s)·병합·스타일 part 가 보존된다", () => {
    const bytes = buildXlsx();
    const { html, manifest } = encodeXlsxToHtml(bytes);

    // encode: 시트별 편집 테이블 + 안정 주소
    expect(manifest.format).toBe("xlsx");
    expect(manifest.container).toBe("zip");
    expect(html).toContain('data-cell="요약!A1"');
    expect(html).toContain('data-cell="요약!A2"');
    expect(html).toContain("제목");
    expect(html).toContain("이름");
    expect(html).toContain("100");

    // 편집: A2 "이름" → "성명" 으로 텍스트만 바꿈
    const edited = html.replace(
      /(<td data-cell="요약!A2">)이름(<\/td>)/,
      "$1성명$2",
    );
    expect(edited).not.toBe(html); // 치환이 실제로 일어났는지

    const out = decodeHtmlToXlsx(edited, manifest);
    const parts = unzipSync(out);
    const sheetXml = strFromU8(parts["xl/worksheets/sheet1.xml"]!);

    // 1) 편집한 A2 는 inlineStr 로 "성명", 원본 s=1 보존
    expect(sheetXml).toMatch(/<c r="A2"[^>]*t="inlineStr"[^>]*s="1"|<c r="A2"[^>]*s="1"[^>]*t="inlineStr"/);
    expect(sheetXml).toContain("성명");
    expect(sheetXml).not.toContain("이름"); // 시트엔 더 이상 직접 등장 안 함(공유참조였음)

    // 2) 손대지 않은 A1 은 그대로 공유문자열 참조(t="s", s="1") 유지
    expect(sheetXml).toMatch(/<c r="A1"[^>]*s="1"[^>]*t="s"/);

    // 3) 숫자 C3=100 은 그대로
    expect(sheetXml).toContain("100");
    expect(sheetXml).toMatch(/<c r="C3"><v>100<\/v><\/c>/);

    // 4) 병합 보존
    expect(sheetXml).toContain('<mergeCell ref="A1:C1"');

    // 5) 스타일 part 바이트 그대로 복사
    expect(strFromU8(parts["xl/styles.xml"]!)).toBe(
      strFromU8(unzipSync(bytes)["xl/styles.xml"]!),
    );

    // 6) sharedStrings 도 손대지 않음(편집 셀은 inlineStr 로 빠지므로 풀은 불변)
    expect(parts["xl/sharedStrings.xml"]).toBeDefined();
  });
});
