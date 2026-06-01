/**
 * xlsx 미리보기 — 셀 병합·빈 셀 보존·그리드 렌더 검증.
 */
import { describe, it, expect } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { previewHtml } from "../src/index.js";

function xlsx(sheetXml: string, shared: string[] = [], stylesXml?: string, extra: Record<string, Uint8Array> = {}): Uint8Array {
  const sst = `<sst xmlns="x" count="${shared.length}">${shared.map((s) => `<si><t>${s}</t></si>`).join("")}</sst>`;
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>`),
    "xl/workbook.xml": strToU8(`<workbook xmlns="x"><sheets><sheet name="요약"/></sheets></workbook>`),
    "xl/sharedStrings.xml": strToU8(sst),
    "xl/worksheets/sheet1.xml": strToU8(sheetXml),
    ...extra,
  };
  if (stylesXml) files["xl/styles.xml"] = strToU8(stylesXml);
  return zipSync(files);
}

describe("xlsx 미리보기", () => {
  it("셀 병합(mergeCells)을 colspan/rowspan 으로 합친다", () => {
    const sheet = `<worksheet xmlns="x"><dimension ref="A1:C3"/>
      <sheetData>
        <row r="1"><c r="A1" t="s"><v>0</v></c></row>
        <row r="2"><c r="A2" t="s"><v>1</v></c><c r="C2" t="s"><v>2</v></c></row>
        <row r="3"><c r="A3" t="s"><v>3</v></c><c r="C3"><v>100</v></c></row>
      </sheetData>
      <mergeCells count="1"><mergeCell ref="A1:C1"/></mergeCells>
    </worksheet>`;
    const html = previewHtml(xlsx(sheet, ["제목", "이름", "금액", "홍길동"]));
    expect(html).toContain('colspan="3"'); // A1:C1 병합
    expect(html).toContain("제목");
    expect(html).toContain("금액");
    expect(html).toContain("100");
  });

  it("빈 셀도 그리드 자리를 유지한다(원본 그대로)", () => {
    // B2 가 비어있음 — A2, C2 사이에 빈 td 가 있어야 함
    const sheet = `<worksheet xmlns="x"><dimension ref="A1:C2"/>
      <sheetData>
        <row r="2"><c r="A2" t="s"><v>0</v></c><c r="C2" t="s"><v>1</v></c></row>
      </sheetData></worksheet>`;
    const html = previewHtml(xlsx(sheet, ["왼쪽", "오른쪽"]));
    // 열 머리 A,B,C 가 모두 그려진다(빈 B 열도 자리 유지)
    expect(html).toContain(">A</th>");
    expect(html).toContain(">B</th>");
    expect(html).toContain(">C</th>");
    // 행 번호 머리(1,2)도 그려진다
    expect(html).toContain('class="xlsx-rowh">1<');
    expect(html).toContain("왼쪽");
    expect(html).toContain("오른쪽");
  });

  it("셀 배경색·글자색·볼드(styles.xml)를 반영한다", () => {
    // xf0=기본, xf1=빨강 굵은 글씨 + 노랑 배경
    const styles = `<styleSheet xmlns="x">
      <fonts count="2"><font/><font><b/><color rgb="FFFF0000"/></font></fonts>
      <fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>
        <fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/></patternFill></fill></fills>
      <cellXfs count="2"><xf/><xf fontId="1" fillId="2" applyFont="1" applyFill="1"/></cellXfs>
    </styleSheet>`;
    const sheet = `<worksheet xmlns="x"><sheetData><row r="1"><c r="A1" s="1" t="s"><v>0</v></c></row></sheetData></worksheet>`;
    const html = previewHtml(xlsx(sheet, ["강조"], styles));
    expect(html).toMatch(/color:#FF0000/);
    expect(html).toMatch(/font-weight:bold/);
    expect(html).toMatch(/background-color:#FFFF00/);
    expect(html).toContain("강조");
  });

  it("셀 테두리·글자 크기를 반영한다", () => {
    const styles = `<styleSheet xmlns="x">
      <fonts count="2"><font/><font><sz val="18"/></font></fonts>
      <fills count="1"><fill><patternFill patternType="none"/></fill></fills>
      <borders count="2"><border><left/><right/><top/><bottom/></border>
        <border><left style="thin"><color rgb="FF000000"/></left><right style="thin"><color rgb="FF000000"/></right>
          <top style="medium"><color rgb="FF0000FF"/></top><bottom style="thin"><color rgb="FF000000"/></bottom></border></borders>
      <cellXfs count="2"><xf/><xf fontId="1" borderId="1" applyFont="1" applyBorder="1"/></cellXfs>
    </styleSheet>`;
    const sheet = `<worksheet xmlns="x"><cols><col min="1" max="1" width="20" customWidth="1"/></cols>
      <sheetData><row r="1" ht="30"><c r="A1" s="1" t="s"><v>0</v></c></row></sheetData></worksheet>`;
    const html = previewHtml(xlsx(sheet, ["큰글씨"], styles));
    expect(html).toMatch(/font-size:18pt/);
    expect(html).toMatch(/border-top:2px solid #0000FF/);
    expect(html).toMatch(/border-left:1px solid #000000/);
    expect(html).toContain('width:145px'); // 20*7+5
    expect(html).toMatch(/<tr style="height:40px"/); // 30pt → 40px
    expect(html).not.toContain("position:sticky"); // sticky 제거로 테두리 깨짐 방지
  });

  it("빈 셀이라도 배경색이 있으면 색을 표시한다", () => {
    const styles = `<styleSheet xmlns="x">
      <fonts count="1"><font/></fonts>
      <fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>
        <fill><patternFill patternType="solid"><fgColor rgb="FF00B0F0"/></patternFill></fill></fills>
      <cellXfs count="2"><xf/><xf fillId="2" applyFill="1"/></cellXfs>
    </styleSheet>`;
    // A1 은 값 없이 스타일(s=1)만 — 색칠된 빈 셀
    const sheet = `<worksheet xmlns="x"><dimension ref="A1:A1"/><sheetData><row r="1"><c r="A1" s="1"/></row></sheetData></worksheet>`;
    const html = previewHtml(xlsx(sheet, [], styles));
    expect(html).toMatch(/background-color:#00B0F0/);
  });

  it("글꼴 이름은 작은따옴표로 — style 속성이 안 깨져 배경·테두리가 유지된다", () => {
    // 글꼴 이름에 공백("맑은 고딕")이 있어도 큰따옴표면 style 속성이 조기 종료돼 뒤 선언이 무시됨 → 작은따옴표여야 함
    const styles = `<styleSheet xmlns="x">
      <fonts count="1"><font><name val="맑은 고딕"/></font></fonts>
      <fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>
        <fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/></patternFill></fill></fills>
      <cellXfs count="1"><xf fontId="0" fillId="2" applyFont="1" applyFill="1"/></cellXfs>
    </styleSheet>`;
    const sheet = `<worksheet xmlns="x"><sheetData><row r="1"><c r="A1" s="0" t="s"><v>0</v></c></row></sheetData></worksheet>`;
    const html = previewHtml(xlsx(sheet, ["값"], styles));
    expect(html).toMatch(/font-family:'맑은 고딕'/);
    // 같은 style 속성 안에 font-family 와 background-color 가 함께 있어야(중간에 큰따옴표 없이)
    expect(html).toMatch(/style="[^"]*font-family:'[^']*'[^"]*background-color:#FFFF00[^"]*"/);
  });

  it("시트에 앵커된 이미지를 미리보기에 표시한다", () => {
    const png = new Uint8Array(
      Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"),
    );
    const extra: Record<string, Uint8Array> = {
      "xl/worksheets/_rels/sheet1.xml.rels": strToU8(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>`),
      "xl/drawings/drawing1.xml": strToU8(`<xdr:wsDr xmlns:xdr="d" xmlns:a="a" xmlns:r="r"><xdr:twoCellAnchor><xdr:from><xdr:col>1</xdr:col><xdr:row>2</xdr:row></xdr:from><xdr:pic><xdr:blipFill><a:blip r:embed="rId1"/></xdr:blipFill></xdr:pic></xdr:twoCellAnchor></xdr:wsDr>`),
      "xl/drawings/_rels/drawing1.xml.rels": strToU8(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/></Relationships>`),
      "xl/media/image1.png": png,
    };
    const sheet = `<worksheet xmlns="x"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>`;
    const html = previewHtml(xlsx(sheet, ["x"], undefined, extra));
    expect(html).toContain("xlsx-images");
    expect(html).toContain("data:image/png;base64,");
    expect(html).toContain("B3"); // col1,row2 → B3 위치 캡션
  });

  it("표시 못 하는 형식(EMF/WMF)은 자리표시자로 알려준다", () => {
    const extra: Record<string, Uint8Array> = {
      "xl/worksheets/_rels/sheet1.xml.rels": strToU8(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>`),
      "xl/drawings/drawing1.xml": strToU8(`<xdr:wsDr xmlns:xdr="d" xmlns:a="a" xmlns:r="r"><xdr:oneCellAnchor><xdr:from><xdr:col>0</xdr:col><xdr:row>0</xdr:row></xdr:from><xdr:pic><xdr:blipFill><a:blip r:embed="rId1"/></xdr:blipFill></xdr:pic></xdr:oneCellAnchor></xdr:wsDr>`),
      "xl/drawings/_rels/drawing1.xml.rels": strToU8(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.emf"/></Relationships>`),
      "xl/media/image1.emf": new Uint8Array([1, 2, 3, 4]),
    };
    const sheet = `<worksheet xmlns="x"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>`;
    const html = previewHtml(xlsx(sheet, ["x"], undefined, extra));
    expect(html).toContain("브라우저 미표시");
    expect(html).toContain("EMF 형식");
  });

  it("가로 스크롤 컨테이너로 감싸 레이아웃이 무너지지 않는다", () => {
    const html = previewHtml(xlsx(`<worksheet xmlns="x"><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>`));
    expect(html).toContain("xlsx-scroll");
    expect(html).toMatch(/\.xlsx-scroll\s*\{[^}]*overflow:\s*auto/);
  });
});
