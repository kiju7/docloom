/**
 * pptx 슬라이드 미리보기 — 절대위치·표·이미지·텍스트 서식 검증.
 * (registry/index 를 거치지 않고 어댑터를 직접 검증한다.)
 */
import { describe, it, expect } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { pptxToPreviewHtml } from "../src/formats/pptx.js";

const PNG = new Uint8Array(
  Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"),
);

function pptx(slideXml: string, extra: Record<string, Uint8Array> = {}): Uint8Array {
  return zipSync({
    "[Content_Types].xml": strToU8(`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>`),
    "ppt/presentation.xml": strToU8(`<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId r:id="rId1"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/></p:presentation>`),
    "ppt/_rels/presentation.xml.rels": strToU8(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>`),
    "ppt/slides/slide1.xml": strToU8(slideXml),
    ...extra,
  });
}

const NS = `xmlns:p="p" xmlns:a="a" xmlns:r="r"`;

describe("pptx 슬라이드 미리보기", () => {
  it("슬라이드 크기(EMU)를 px 캔버스로, 도형을 xfrm 으로 절대 배치한다", () => {
    const slide = `<p:sld ${NS}><p:cSld><p:spTree>
      <p:sp><p:spPr><a:xfrm><a:off x="914400" y="457200"/><a:ext cx="3657600" cy="1828800"/></a:xfrm></p:spPr>
        <p:txBody><a:p><a:r><a:rPr sz="2400" b="1"/><a:t>제목 텍스트</a:t></a:r></a:p></p:txBody></p:sp>
    </p:spTree></p:cSld></p:sld>`;
    const html = pptxToPreviewHtml(pptx(slide));
    expect(html).toContain("width:960px;height:720px"); // 9144000/9525, 6858000/9525
    expect(html).toMatch(/position:absolute;left:96px;top:48px;width:384px;height:192px/);
    expect(html).toContain("제목 텍스트");
    expect(html).toMatch(/font-size:24pt/); // sz=2400
    expect(html).toContain("font-weight:bold");
  });

  it("표(a:tbl)를 위치·셀과 함께 렌더한다", () => {
    const slide = `<p:sld ${NS}><p:cSld><p:spTree>
      <p:graphicFrame><p:xfrm><a:off x="0" y="0"/><a:ext cx="1905000" cy="952500"/></p:xfrm>
        <a:graphic><a:graphicData><a:tbl><a:tblGrid><a:gridCol w="952500"/><a:gridCol w="952500"/></a:tblGrid>
          <a:tr h="476250"><a:tc><a:txBody><a:p><a:r><a:t>머리1</a:t></a:r></a:p></a:txBody></a:tc>
            <a:tc><a:txBody><a:p><a:r><a:t>머리2</a:t></a:r></a:p></a:txBody></a:tc></a:tr>
        </a:tbl></a:graphicData></a:graphic></p:graphicFrame>
    </p:spTree></p:cSld></p:sld>`;
    const html = pptxToPreviewHtml(pptx(slide));
    expect(html).toContain("pptx-tbl");
    expect(html).toContain("머리1");
    expect(html).toContain("머리2");
    expect(html).toMatch(/<col style="width:100px"/); // 952500/9525
  });

  it("그림(p:pic)을 slide rels 로 찾아 data URI 로 표시한다", () => {
    const slide = `<p:sld ${NS}><p:cSld><p:spTree>
      <p:pic><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="952500" cy="952500"/></a:xfrm></p:spPr>
        <p:blipFill><a:blip r:embed="rId1"/></p:blipFill></p:pic>
    </p:spTree></p:cSld></p:sld>`;
    const extra = {
      "ppt/slides/_rels/slide1.xml.rels": strToU8(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/></Relationships>`),
      "ppt/media/image1.png": PNG,
    };
    const html = pptxToPreviewHtml(pptx(slide, extra));
    expect(html).toContain("data:image/png;base64,");
  });

  it("글자 크기·색·정렬·글머리를 슬라이드 마스터 txStyles 에서 상속한다", () => {
    // 본문 플레이스홀더 + rPr/pPr 비어있음 → 마스터 bodyStyle lvl1 에서 상속
    const slide = `<p:sld ${NS}><p:cSld><p:spTree>
      <p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="5000000" cy="3000000"/></a:xfrm></p:spPr>
        <p:txBody><a:p><a:r><a:t>본문 항목</a:t></a:r></a:p></p:txBody></p:sp>
    </p:spTree></p:cSld></p:sld>`;
    const extra = {
      "ppt/slides/_rels/slide1.xml.rels": strToU8(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>`),
      "ppt/slideLayouts/slideLayout1.xml": strToU8(`<p:sldLayout ${NS}><p:cSld><p:spTree/></p:cSld></p:sldLayout>`),
      "ppt/slideLayouts/_rels/slideLayout1.xml.rels": strToU8(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`),
      "ppt/slideMasters/slideMaster1.xml": strToU8(`<p:sldMaster ${NS}><p:txStyles><p:bodyStyle>
        <a:lvl1pPr algn="ctr" marL="457200"><a:buChar char="–"/><a:defRPr sz="2800" b="1"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:defRPr></a:lvl1pPr>
      </p:bodyStyle></p:txStyles></p:sldMaster>`),
    };
    const html = pptxToPreviewHtml(pptx(slide, extra));
    expect(html).toContain("본문 항목");
    expect(html).toMatch(/font-size:28pt/);
    expect(html).toContain("font-weight:bold");
    expect(html).toMatch(/color:#FF0000/);
    expect(html).toMatch(/text-align:center/);
    expect(html).toContain("pptx-bul"); // 글머리 기호
    expect(html).toMatch(/padding-left:48px/); // marL 457200 EMU → 48px
  });

  it("xfrm 없는 플레이스홀더는 slideLayout 에서 위치를 상속한다", () => {
    const slide = `<p:sld ${NS}><p:cSld><p:spTree>
      <p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
        <p:spPr/><p:txBody><a:p><a:r><a:t>상속 제목</a:t></a:r></a:p></p:txBody></p:sp>
    </p:spTree></p:cSld></p:sld>`;
    const extra = {
      "ppt/slides/_rels/slide1.xml.rels": strToU8(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>`),
      "ppt/slideLayouts/slideLayout1.xml": strToU8(`<p:sldLayout ${NS}><p:cSld><p:spTree>
        <p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
          <p:spPr><a:xfrm><a:off x="762000" y="381000"/><a:ext cx="7620000" cy="1143000"/></a:xfrm></p:spPr></p:sp>
      </p:spTree></p:cSld></p:sldLayout>`),
    };
    const html = pptxToPreviewHtml(pptx(slide, extra));
    expect(html).toContain("상속 제목");
    expect(html).toMatch(/position:absolute;left:80px;top:40px/); // 762000/9525=80, 381000/9525=40
  });
});
