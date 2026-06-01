/**
 * 실파일(sample.doc, 한국천문연구원 OpenAPI 활용가이드) 리치 미리보기 검증.
 *
 * 옛 .doc 미리보기는 텍스트만 평문으로 흘렸다. 이제 CHPX/PAPX/스타일을 복원해
 * 글자크기·굵게·색·정렬·표·자동 페이지나눔까지 렌더한다. 그 충실도를 회귀로 고정한다.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { docToPreviewHtml } from "../src/formats/doc.js";
import { renderDocResult } from "../src/preview/docRender.js";

const fixture = fileURLToPath(new URL("./fixtures/sample.doc", import.meta.url));
const run = existsSync(fixture) ? describe : describe.skip;

run("sample.doc 리치 미리보기", () => {
  // describe.skip 이어도 본문은 수집 단계에서 실행되므로, 픽스처가 없으면 빈 바이트로 둔다.
  const bytes = existsSync(fixture) ? new Uint8Array(readFileSync(fixture)) : new Uint8Array();

  it("서식 입은 <p style> 와 <span style> 으로 렌더한다(평문 아님)", () => {
    const html = docToPreviewHtml(bytes, { title: "sample.doc" });
    expect(html).toContain('<p style="');
    expect(html).toContain("<span");
    // 본문 텍스트 존재
    expect(html).toContain("OpenAPI");
    expect(html).toContain("한국천문연구원");
  });

  it("필드코드(STYLEREF/HYPERLINK/TOC/FILENAME 지시문)는 결과만 남기고 숨긴다", () => {
    const html = docToPreviewHtml(bytes);
    expect(html).not.toContain("STYLEREF");
    expect(html).not.toContain("MERGEFORMAT");
    expect(html).not.toContain("HYPERLINK");
    expect(html).not.toMatch(/TOC \\/);
  });

  it("글자크기(font-size)·굵게·색을 복원한다", () => {
    const { body } = renderDocResult(bytes);
    expect(body).toMatch(/font-size:\d/); // 크기 SPRM(sprmCHps) 반영
    expect(body).toContain("font-weight:bold"); // 제목/머리글 굵게
    expect(body).toMatch(/color:#[0-9a-f]{6}/); // 색(한국천문연구원 파랑 등)
  });

  it("문단 정렬(가운데/오른쪽)을 복원한다", () => {
    const { body } = renderDocResult(bytes);
    expect(body).toContain("text-align:center");
    expect(body).toContain("text-align:right");
  });

  it("표를 <table> 로 재구성한다(개정 이력 등)", () => {
    const { body } = renderDocResult(bytes);
    const tables = (body.match(/<table class="docloom-table">/g) ?? []).length;
    expect(tables).toBeGreaterThan(3);
    expect(body).toContain("개정 이력");
    expect(body).toContain("최초작성");
  });

  it("인라인 이미지(OfficeArt BLIP)를 data URI <img> 로 추출한다", () => {
    const { body } = renderDocResult(bytes);
    const imgs = (body.match(/<img src="data:image\//g) ?? []).length;
    expect(imgs).toBeGreaterThanOrEqual(5); // 가이드 스크린샷 5장
    expect(body).toContain("data:image/png;base64,");
  });

  it("표 셀 배경(음영)과 테두리(굵기/투명)를 복원한다", () => {
    const { body } = renderDocResult(bytes);
    // 문서정보 표 라벨열 회색 음영 #d9d9d9
    expect(body).toMatch(/<td[^>]*background:#d9d9d9/i);
    // TC80 테두리(pt 단위) 적용
    expect(body).toMatch(/<td[^>]*border-\w+:[\d.]+pt (solid|none)/);
    // 일부 변은 테두리 없음(투명)
    expect(body).toMatch(/border-\w+:none/);
  });

  it("표 셀 세로/가로 병합(rowspan/colspan)을 복원한다", () => {
    const { body } = renderDocResult(bytes);
    // 서비스 명세 표의 라벨열 세로 병합 → rowspan
    expect(body).toMatch(/<td[^>]*rowspan="\d+"/);
    const rowspans = (body.match(/rowspan="/g) ?? []).length;
    expect(rowspans).toBeGreaterThan(5);
  });

  it("목록 자동번호(1./1.1./가./(1))를 생성한다", () => {
    const { body } = renderDocResult(bytes);
    expect(body).toContain("doc-list-num");
    expect(body).toMatch(/doc-list-num">1\./); // 십진
    expect(body).toMatch(/doc-list-num">가/); // 한글 가나다(nfc24)
  });

  it("TOC 점선 리더를 flex 레이아웃으로 렌더한다", () => {
    const { body } = renderDocResult(bytes);
    expect(body).toContain("doc-leader");
    expect(body).toMatch(/display:flex;align-items:baseline/);
  });

  it("텍스트박스 내부 텍스트와 EMF/WMF 자리표시를 처리한다", () => {
    const { body } = renderDocResult(bytes);
    expect(body).toContain("목 차"); // 텍스트박스 "목 차"
  });

  it("OfficeArt 도형(표지 점선)을 렌더한다", () => {
    const { body } = renderDocResult(bytes);
    expect(body).toContain("doc-shape-line"); // 표지 가로 점선
    expect(body).toMatch(/border-top:\d+px dotted/); // 점선 스타일
  });

  it("꼬리말을 라이브 페이지번호 span 으로 렌더한다", () => {
    const { footer } = renderDocResult(bytes);
    expect(footer).toContain('class="page-number"'); // PAGE 필드 → 시트별 번호
    expect(footer).toContain("text-align:center");
  });

  it("자동 페이지나눔용 용지 기하와 페이지엔진 마크업을 낸다", () => {
    const { section } = renderDocResult(bytes);
    expect(section.page.wPx).toBeGreaterThan(400);
    expect(section.page.hPx).toBeGreaterThan(section.page.wPx);
    const html = docToPreviewHtml(bytes);
    expect(html).toContain('id="dl-pages"'); // toPagedHtml 페이지네이터
  });
});
