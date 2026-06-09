/**
 * 미리보기 렌더러.
 *
 * encodeToHtml 이 주는 html 은 "편집/왕복용 본문 조각"이라 CSS 가 없다.
 * 브라우저에서 양식처럼 보려면 이 모듈로 CSS 를 입혀 자체 완결 HTML 페이지로 감싼다.
 *
 * CSS 는 두 층으로 나뉜다.
 *   - LAYOUT_CSS        : 페이지/배경/표/frozen 등 "구조" 스타일 (항상 적용)
 *   - typographyCss     : 스타일별 글꼴·크기·정렬 등 "타이포그래피"
 *                         (styleCss.extractStyleCss 가 원본 styles.xml 에서 추출.
 *                          없으면 FALLBACK_TYPOGRAPHY 사용)
 */

/** 구조 스타일 — 한 페이지처럼 보이게 하는 골격. 타이포그래피는 별도. */
export const LAYOUT_CSS = `
:root { --page: 800px; }
body {
  margin: 0; padding: 32px 0;
  background: #f2f3f5;
  font-family: -apple-system, "Segoe UI", "Malgun Gothic", "Apple SD Gothic Neo", sans-serif;
  color: #1a1a1a;
}
.docloom-doc {
  width: var(--page); max-width: calc(100% - 32px);
  margin: 0 auto; padding: 64px 72px;
  background: #fff;
  box-shadow: 0 1px 4px rgba(0,0,0,.12), 0 8px 24px rgba(0,0,0,.08);
  line-height: 1.7;
}
.docloom-doc table, .docloom-table { border-collapse: collapse; margin: 12px 0; width: 100%; }
.docloom-doc td, .docloom-table td { border: 1px solid #c9ccd1; padding: 6px 10px; vertical-align: top; }
/* 원본 테두리를 인라인으로 입힌 표: 회색 기본 테두리 끄고 셀 인라인 border 만 따른다. */
.docloom-table-bordered td { border: 0; }
.docloom-doc .s-frozen {
  border: 1px dashed #b0b4ba; border-radius: 6px;
  padding: 10px 12px; margin: 12px 0;
  color: #6b7280; font-size: 13px; background: #fafbfc;
}
/* 머리말 / 꼬리말 */
.docloom-header, .docloom-footer {
  width: var(--page); max-width: calc(100% - 32px);
  margin: 0 auto; padding: 8px 72px; box-sizing: border-box;
  background: #fff; color: #6b7280; font-size: 11px;
}
.docloom-header { border-bottom: 1px solid #e3e5e8; border-radius: 8px 8px 0 0; padding-top: 20px; }
.docloom-footer { border-top: 1px solid #e3e5e8; border-radius: 0 0 8px 8px; padding-bottom: 20px;
  box-shadow: 0 8px 24px rgba(0,0,0,.08); }
.docloom-header p, .docloom-footer p { margin: 2px 0; }
/* 머리말/꼬리말의 레이아웃 표는 테두리 없이, 좌/우 정렬 */
.docloom-header table, .docloom-footer table { margin: 0; }
.docloom-header td, .docloom-footer td { border: none; padding: 0 4px; }
.docloom-header td:last-child, .docloom-footer td:last-child { text-align: right; }
/* 페이지 나눔 표시 */
.docloom-pagebreak { display: block; height: 0;
  border-top: 1px dashed #c0c4ca; margin: 18px -72px; }
.docloom-pagebreak::after {
  content: "⎯ 페이지 나눔 ⎯"; display: block; text-align: center;
  font-size: 10px; color: #aab; margin-top: -7px; background: #fff; width: 110px;
  margin-left: auto; margin-right: auto;
}
.docloom-tab { display: inline-block; width: 2em; }
.docloom-marker { display: inline-block; min-width: 1.2em; }
.docloom-img { max-width: 100%; height: auto; image-orientation: none; }  /* Word 처럼 EXIF 자동회전 끔 */
`;

/** styles.xml 추출이 불가능할 때 쓰는 기본 타이포그래피(팔레트 기준 추정). */
export const FALLBACK_TYPOGRAPHY = `
.docloom-doc .s-title { font-size: 21pt; font-weight: 700; text-align: center; margin: 0 0 18pt; }
.docloom-doc .s-heading1 { font-size: 15pt; font-weight: 700; margin: 21pt 0 7pt; }
.docloom-doc .s-heading2 { font-size: 13pt; font-weight: 700; margin: 16pt 0 6pt; }
.docloom-doc .s-heading3 { font-size: 11pt; font-weight: 700; margin: 13pt 0 5pt; }
.docloom-doc .s-body { font-size: 11pt; margin: 0 0 8pt; }
.docloom-doc .s-listItem { font-size: 11pt; margin: 0 0 5pt; }
`;

/** 하위호환: 구조 + 기본 타이포그래피 합본. */
export const BASE_PREVIEW_CSS = LAYOUT_CSS + FALLBACK_TYPOGRAPHY;

export interface PreviewOptions {
  /** 문서 제목 (브라우저 탭). */
  title?: string;
  /** 스타일별 타이포그래피 CSS. 보통 extractStyleCss 결과를 넣는다. */
  typographyCss?: string;
  /** 맨 뒤에 덧붙일 추가 CSS. */
  css?: string;
  /** true 면 LAYOUT/타이포그래피를 빼고 css 만 사용. */
  replaceCss?: boolean;
  /** PDF: 미리보기로 렌더할 최대 페이지 수(성능). 기본 60. 초과분은 안내 배너. */
  maxPages?: number;
}

/** 본문 HTML 조각 → 자체 완결 미리보기 HTML 페이지. */
export function toPreviewHtml(bodyHtml: string, opts: PreviewOptions = {}): string {
  const title = escapeAttr(opts.title ?? "docloom preview");
  const typography = opts.typographyCss ?? FALLBACK_TYPOGRAPHY;
  const core = opts.replaceCss ? "" : `${LAYOUT_CSS}\n${typography}`;
  const css = core + (opts.css ? `\n${opts.css}` : "");
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${css}</style>
</head>
<body>
${bodyHtml}
</body>
</html>
`;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}

// ── 페이지(워드처럼) 방식 ──────────────────────────────────────────────────

import type { RenderResult } from "./render.js";

/** 페이지 레이아웃 CSS — A4 시트, 머리말/꼬리말은 여백 안에 절대배치. 치수는 인라인 var. */
export const PAGE_CSS = `
body { margin: 0; padding: 28px 0; background: #eceef0;
  font-family: -apple-system, "Segoe UI", "Malgun Gothic", "Apple SD Gothic Neo", sans-serif;
  color: #1a1a1a; }
.page {
  position: relative; box-sizing: border-box;
  width: var(--pw); height: var(--ph);
  padding: var(--mt) var(--mr) var(--mb) var(--ml);
  margin: 0 auto 22px; background: #fff;
  box-shadow: 0 1px 4px rgba(0,0,0,.12), 0 8px 24px rgba(0,0,0,.10);
  overflow: hidden;
  border-top: var(--bt, none); border-right: var(--br, none);
  border-bottom: var(--bb, none); border-left: var(--bl, none);
}
/* 본문 영역: 다단(column-count) + 단 간격 + 구분선.
   단일 단이면 --cols:auto → multi-column 컨테이너가 아님(세로 넘침/페이지 분할 정상).
   2단 이상일 때만 multicol 컨테이너가 된다. */
.page-content {
  height: 100%; overflow: hidden; line-height: 1.7;
  column-count: var(--cols, auto);
  column-gap: var(--colgap, normal);
  column-rule: var(--colrule, none);
}
/* 각 페이지 첫 블록의 위 여백 제거 → 본문이 상단 여백에 정확히 붙어, 페이지마다
   시작 높이가 들쭉날쭉하지 않게 한다(워드도 페이지 맨 위 문단 앞 간격을 억제). */
.page-content > :first-child { margin-top: 0 !important; }
.page-header, .page-footer {
  position: absolute; left: var(--ml); right: var(--mr);
  color: #555; font-size: 11px;
}
.page-header { top: var(--hy); }
.page-footer { bottom: var(--fy); }
.page-aid { position: absolute; bottom: calc(var(--fy) / 3); left: 0; right: 0;
  text-align: center; font-size: 10px; color: #b3b8c0; }
.docloom-pagebreak { display: block; height: 0; }
.docloom-tab { display: inline-block; width: 2em; }
.docloom-marker { display: inline-block; min-width: 1.2em; }
.docloom-img { max-width: 100%; height: auto; image-orientation: none; }  /* Word 처럼 EXIF 자동회전 끔 */
/* 본문 표: 테두리 있음 */
.docloom-table { border-collapse: collapse; width: 100%; margin: 8px 0; }
.docloom-table td { border: 1px solid #c9ccd1; padding: 6px 10px; vertical-align: top; }
.docloom-table-bordered td { border: 0; }
/* 머리말/꼬리말의 레이아웃 표: 테두리 없음 (더 구체적 선택자로 위 규칙을 확실히 덮음) */
.page-header .docloom-table, .page-footer .docloom-table { margin: 0; }
.page-header .docloom-table td, .page-footer .docloom-table td { border: none; padding: 0 4px; }
.page-header .docloom-table td:last-child, .page-footer .docloom-table td:last-child { text-align: right; }
`;

export interface PagedOptions {
  title?: string;
  typographyCss?: string;
  /** 문서에 페이지번호 필드가 없어도 시트마다 미리보기용 번호를 표시(기본 true). */
  showPageAid?: boolean;
}

/** RenderResult → 워드처럼 A4 시트로 페이지 분할되는 자체완결 HTML(브라우저에서 분할). */
export function toPagedHtml(r: RenderResult, opts: PagedOptions = {}): string {
  const title = escapeAttr(opts.title ?? "docloom preview");
  const typography = opts.typographyCss ?? "";
  const g = r.section.page;
  const c = r.section.cols;
  const b = r.section.borders;
  // 단일 단이면 column-count 를 auto 로 둬 multicol 컨테이너가 되지 않게 한다(페이지 분할 정상).
  // 2단 이상일 때만 실제 다단 적용.
  const colVars =
    c.num > 1
      ? `--cols:${c.num};--colgap:${c.space}px;--colrule:${c.sep ? "1px solid #b0b4ba" : "none"}`
      : `--cols:auto;--colgap:normal;--colrule:none`;
  const borderVars = b
    ? `;--bt:${b.top ?? "none"};--br:${b.right ?? "none"};--bb:${b.bottom ?? "none"};--bl:${b.left ?? "none"}`
    : "";
  const vars =
    `--pw:${g.wPx}px;--ph:${g.hPx}px;--mt:${g.topPx}px;--mr:${g.rightPx}px;` +
    `--mb:${g.bottomPx}px;--ml:${g.leftPx}px;--hy:${g.headerPx}px;--fy:${g.footerPx}px;` +
    colVars + borderVars;
  const showAid = opts.showPageAid !== false;

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
:root{${vars}}
${PAGE_CSS}
${typography}
</style>
</head>
<body>
<template id="dl-header">${r.header}</template>
<template id="dl-footer">${r.footer}</template>
<div id="dl-source" class="docloom-doc" data-palette="doc" style="display:none">${r.body}</div>
<div id="dl-pages"></div>
<script>${PAGINATOR_JS.replace("__SHOW_AID__", String(showAid))}</script>
</body>
</html>
`;
}

/**
 * 브라우저에서 실행되는 페이지네이터.
 * 소스 블록을 하나씩 시트에 채우며 높이를 측정해 넘치면 새 시트를 만든다.
 * 머리말/꼬리말을 시트마다 복제하고, 페이지번호 필드(.page-number)와 보조번호(.page-aid)를 채운다.
 */
const PAGINATOR_JS = `
(function(){
  var SHOW_AID = __SHOW_AID__;
  var source = document.getElementById('dl-source');
  var pagesEl = document.getElementById('dl-pages');
  var headerHtml = document.getElementById('dl-header').innerHTML;
  var footerHtml = document.getElementById('dl-footer').innerHTML;
  var blocks = Array.prototype.slice.call(source.children);

  function newPage(){
    var page = document.createElement('div'); page.className = 'page';
    var content = document.createElement('div'); content.className = 'page-content docloom-doc';
    page.appendChild(content);
    if (headerHtml.trim()){ var h=document.createElement('div'); h.className='page-header'; h.innerHTML=headerHtml; page.appendChild(h); }
    if (footerHtml.trim()){ var f=document.createElement('div'); f.className='page-footer'; f.innerHTML=footerHtml; page.appendChild(f); }
    if (SHOW_AID){ var a=document.createElement('div'); a.className='page-aid'; page.appendChild(a); }
    pagesEl.appendChild(page);
    // 머리말/꼬리말이 여백 밴드보다 크면 본문을 밀어 겹침 방지(워드처럼 본문 시작을 내림).
    // 머리말은 top:--hy 에 절대배치되므로 padding-top 을 키워도 머리말은 그대로, 본문만 내려간다.
    var rootCS = getComputedStyle(document.documentElement);
    var num = function(s){ return parseFloat(s) || 0; };
    var GAP = 6;
    if (h){
      var need = num(rootCS.getPropertyValue('--hy')) + h.offsetHeight + GAP;
      if (need > num(getComputedStyle(page).paddingTop)) page.style.paddingTop = need + 'px';
    }
    if (f){
      var needB = num(rootCS.getPropertyValue('--fy')) + f.offsetHeight + GAP;
      if (needB > num(getComputedStyle(page).paddingBottom)) page.style.paddingBottom = needB + 'px';
    }
    return content;
  }

  function overflowing(c){ return c.scrollHeight > c.clientHeight + 1; }

  function paginate(){
    var content = newPage();
    for (var i=0;i<blocks.length;i++){
      var block = blocks[i];
      var hasBreak = block.querySelector && block.querySelector('.docloom-pagebreak');
      content.appendChild(block);
      if (overflowing(content)){
        if (content.children.length === 1){
          // 한 블록이 한 페이지보다 큼 → 그대로 두고(초과분은 잘림) 다음 시트로
          content = newPage();
        } else {
          content.removeChild(block);
          content = newPage();
          content.appendChild(block);
        }
      }
      if (hasBreak){ content = newPage(); }
    }
    source.parentNode.removeChild(source);

    // 페이지 번호 채우기
    var pages = pagesEl.querySelectorAll('.page');
    var total = pages.length;
    for (var p=0;p<pages.length;p++){
      var n = p+1;
      var nums = pages[p].querySelectorAll('.page-number');
      for (var k=0;k<nums.length;k++){
        nums[k].textContent = nums[k].getAttribute('data-field')==='NUMPAGES' ? String(total) : String(n);
      }
      var aid = pages[p].querySelector('.page-aid');
      if (aid) aid.textContent = n + ' / ' + total;
    }
  }

  // 이미지(data URI 포함)는 디코드 전 높이가 0 이라, 로드된 뒤 페이지를 나눈다.
  // (안 그러면 측정이 0 → 한 페이지에 몰림 → 로드 후 넘쳐서 형식 붕괴)
  var imgs = source.querySelectorAll('img');
  var pending = 0, started = false;
  function go(){ if (started) return; started = true; paginate(); }
  function settle(){ if (--pending <= 0) go(); }
  for (var qi=0; qi<imgs.length; qi++){
    var im = imgs[qi];
    if (!im.complete || im.naturalHeight === 0){
      pending++;
      im.addEventListener('load', settle);
      im.addEventListener('error', settle);
    }
  }
  if (pending === 0) go();
  else setTimeout(go, 3000); // 안전망: 이미지가 끝내 안 와도 3초 뒤 진행
})();
`;
