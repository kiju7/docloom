/**
 * pptx 왕복(encode → HTML 편집 → decode) — 텍스트는 바뀌고 서식·위치·다른 슬라이드는 보존.
 */
import { describe, it, expect } from "vitest";
import { zipSync, strToU8, unzipSync, strFromU8 } from "fflate";
import { encodePptxToHtml } from "../src/encode/pptxToHtml.js";
import { decodeHtmlToPptx } from "../src/decode/htmlToPptx.js";

const NS = `xmlns:p="p" xmlns:a="a" xmlns:r="r"`;

// spTree 안에 공백 텍스트 노드가 없도록 한 줄로(인덱스 경로가 예측 가능해짐).
const SLIDE1 = `<p:sld ${NS}><p:cSld><p:spTree><p:sp><p:spPr><a:xfrm><a:off x="914400" y="457200"/><a:ext cx="3657600" cy="1828800"/></a:xfrm></p:spPr><p:txBody><a:p><a:r><a:rPr sz="2400" b="1"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:rPr><a:t>안녕</a:t></a:r><a:r><a:rPr sz="1800"/><a:t>세계</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;

const SLIDE2 = `<p:sld ${NS}><p:cSld><p:spTree><p:sp><p:spPr><a:xfrm><a:off x="100" y="200"/><a:ext cx="300" cy="400"/></a:xfrm></p:spPr><p:txBody><a:p><a:r><a:rPr sz="1200"/><a:t>둘째 슬라이드</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;

function pptx(): Uint8Array {
  return zipSync({
    "[Content_Types].xml": strToU8(`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`),
    "ppt/presentation.xml": strToU8(`<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId r:id="rId1"/><p:sldId r:id="rId2"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/></p:presentation>`),
    "ppt/_rels/presentation.xml.rels": strToU8(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/></Relationships>`),
    "ppt/slides/slide1.xml": strToU8(SLIDE1),
    "ppt/slides/slide2.xml": strToU8(SLIDE2),
    "ppt/media/image1.png": new Uint8Array([1, 2, 3, 4]),
  });
}

describe("pptx 왕복", () => {
  it("encode 가 슬라이드별 편집 가능한 런 식별자를 낸다", () => {
    const { html, manifest } = encodePptxToHtml(pptx());
    expect(manifest.format).toBe("pptx");
    expect(manifest.container).toBe("zip");
    expect(html).toContain('data-slide="ppt/slides/slide1.xml"');
    expect(html).toContain("안녕");
    expect(html).toContain("세계");
    expect(html).toContain('data-run="ppt/slides/slide1.xml|0|p0|r0"');
    expect(html).toContain('data-run="ppt/slides/slide1.xml|0|p0|r1"');
    expect(html).toContain("둘째 슬라이드");
  });

  it("런 텍스트를 편집하고 decode 하면 텍스트만 바뀌고 rPr·xfrm·다른 슬라이드는 보존된다", () => {
    const { html, manifest } = encodePptxToHtml(pptx());

    // 첫 런 텍스트만 편집
    const edited = html.replace(
      '<span data-run="ppt/slides/slide1.xml|0|p0|r0">안녕</span>',
      '<span data-run="ppt/slides/slide1.xml|0|p0|r0">반가워</span>',
    );
    expect(edited).not.toBe(html); // 치환이 실제로 일어났는지

    const out = decodeHtmlToPptx(edited, manifest);
    const parts = unzipSync(out);
    const s1 = strFromU8(parts["ppt/slides/slide1.xml"]!);
    const s2 = strFromU8(parts["ppt/slides/slide2.xml"]!);

    // 텍스트가 바뀌었다
    expect(s1).toContain("<a:t>반가워</a:t>");
    expect(s1).not.toContain("<a:t>안녕</a:t>");
    // 둘째 런은 그대로
    expect(s1).toContain("<a:t>세계</a:t>");

    // 런 서식(a:rPr) 보존: 첫 런의 색·크기·볼드
    expect(s1).toMatch(/sz="2400"/);
    expect(s1).toMatch(/b="1"/);
    expect(s1).toContain('<a:srgbClr val="FF0000"');
    // 도형 위치(xfrm) 보존
    expect(s1).toContain('<a:off x="914400" y="457200"');
    expect(s1).toContain('<a:ext cx="3657600" cy="1828800"');

    // 다른 슬라이드는 손대지 않음
    expect(s2).toContain("둘째 슬라이드");
    expect(s2).toContain('<a:off x="100" y="200"');

    // 편집 안 한 part(이미지)는 바이트 그대로
    expect(Array.from(parts["ppt/media/image1.png"]!)).toEqual([1, 2, 3, 4]);
  });

  it("앞뒤 공백 텍스트엔 xml:space=preserve 를 붙인다", () => {
    const { html, manifest } = encodePptxToHtml(pptx());
    const edited = html.replace(
      '<span data-run="ppt/slides/slide1.xml|0|p0|r1">세계</span>',
      '<span data-run="ppt/slides/slide1.xml|0|p0|r1"> 세계 </span>',
    );
    const out = decodeHtmlToPptx(edited, manifest);
    const s1 = strFromU8(unzipSync(out)["ppt/slides/slide1.xml"]!);
    expect(s1).toMatch(/xml:space="preserve"[^>]*> 세계 <\/a:t>|<a:t xml:space="preserve"> 세계 <\/a:t>/);
  });
});
