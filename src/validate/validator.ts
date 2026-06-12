/**
 * 검증기 (Validator) — decode 의 "방화벽".
 *
 * LLM/사람이 만진 HTML 은 신뢰할 수 없다(닫히지 않은 태그, 금지 태그, 인라인
 * 스타일, 모르는 class, script 등). decode 전에 반드시 통과시켜 안전하고 일관된,
 * decode 가 먹을 수 있는 HTML 로 정규화한다.
 *
 * 규칙
 *   - 관용적 HTML 파서(node-html-parser)로 깨진 HTML 도 일단 파싱
 *   - 허용 블록만 남김: p / h1~h6 / li / table / div[data-frozen]
 *       · ul/ol 은 풀어서 li 들을 블록으로 끌어올림
 *       · div/section/article 등 컨테이너는 블록 자식이 있으면 재귀, 없으면 문단화
 *       · 모르는 태그는 언랩(텍스트는 보존)
 *   - class 는 팔레트의 s-<styleKey> 만 허용 → 없거나 모르면 태그로 추론 후 fallback
 *   - 인라인은 strong/em/u/s/br 만 (b→strong, i→em, strike/del→s, span 언랩)
 *   - 인라인 style="" 전면 제거, script/style 등 위험 요소 제거
 *   - data-frozen 자리표시자는 보존 (원본 복원에 필요)
 *
 * "복원 불가능한 입력"을 여기서 원천 차단 → decode 는 항상 유효한 docx 를 만든다.
 */
import { parse, type HTMLElement } from "node-html-parser";
import type { Palette } from "../palette/palette.js";
import {
  classFromStyleKey,
  htmlTagFromStyleKey,
  styleKeyForHtmlTag,
  tryStyleKeyFromClass,
} from "../palette/palette.js";

export const ALLOWED_BLOCK_TAGS = new Set([
  "p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "ul", "ol", "table", "div", "section", "article", "blockquote",
]);
const LEAF_BLOCK_TAGS = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "blockquote"]);

/** 인라인 마크 매핑(별칭 흡수). 그 외 인라인 태그는 언랩. */
const INLINE_MARK_TAGS: Record<string, "strong" | "em" | "u" | "s"> = {
  strong: "strong",
  b: "strong",
  em: "em",
  i: "em",
  u: "u",
  s: "s",
  strike: "s",
  del: "s",
};

export interface ValidateReport {
  removedTags: string[];
  strippedInlineStyles: number;
  remappedClasses: string[];
}

export interface ValidateResult {
  html: string;
  report: ValidateReport;
}

interface Ctx {
  palette: Palette;
  report: ValidateReport;
}

const ELEMENT = 1;
const TEXT = 3;

export function validateHtml(html: string, palette: Palette): ValidateResult {
  const report: ValidateReport = { removedTags: [], strippedInlineStyles: 0, remappedClasses: [] };
  const ctx: Ctx = { palette, report };

  const root = parse(html, { lowerCaseTagName: true, comment: false });
  const container = root.querySelector(".docloom-doc") ?? root;

  const blocks = normalizeBlocks(container, ctx);

  report.removedTags = [...new Set(report.removedTags)];
  report.remappedClasses = [...new Set(report.remappedClasses)];

  const body = blocks.join("\n");
  const out = `<div class="docloom-doc" data-palette="${escapeAttr(palette.id)}">\n${body}\n</div>`;
  return { html: out, report };
}

// ── 블록 정규화 ──────────────────────────────────────────────────────────

function normalizeBlocks(container: HTMLElement, ctx: Ctx): string[] {
  const blocks: string[] = [];
  for (const child of container.childNodes) {
    if (child.nodeType === TEXT) {
      const t = child.text;
      if (t && t.trim()) blocks.push(leafFromText(t, ctx));
      continue;
    }
    if (child.nodeType !== ELEMENT) continue;

    const el = child as HTMLElement;
    const tag = el.tagName.toLowerCase();
    countStyle(el, ctx);

    if (tag === "div" && el.getAttribute("data-frozen")) {
      blocks.push(frozenBlock(el));
      continue;
    }
    if (tag === "ul" || tag === "ol") {
      blocks.push(...normalizeBlocks(el, ctx)); // li 들을 블록으로 끌어올림
      continue;
    }
    if (tag === "table") {
      blocks.push(cleanTable(el, ctx));
      continue;
    }
    if (!ALLOWED_BLOCK_TAGS.has(tag)) {
      ctx.report.removedTags.push(tag);
      if (hasBlockChild(el)) blocks.push(...normalizeBlocks(el, ctx));
      else blocks.push(leafBlock(el, "p", ctx));
      continue;
    }
    if (!LEAF_BLOCK_TAGS.has(tag)) {
      // div/section/article 등 컨테이너
      if (hasBlockChild(el)) blocks.push(...normalizeBlocks(el, ctx));
      else blocks.push(leafBlock(el, "p", ctx));
      continue;
    }
    blocks.push(leafBlock(el, tag, ctx));
  }
  return blocks;
}

function hasBlockChild(el: HTMLElement): boolean {
  return el.childNodes.some(
    (c) => c.nodeType === ELEMENT && ALLOWED_BLOCK_TAGS.has((c as HTMLElement).tagName.toLowerCase()),
  );
}

/** 블록 요소 → 정규화된 단일 블록 HTML. */
function leafBlock(el: HTMLElement, tagHint: string, ctx: Ctx): string {
  const styleKey = resolveStyleKey(el, tagHint, ctx);
  const outTag = htmlTagFromStyleKey(ctx.palette, styleKey);
  // 직접서식 토큰(data-pp)은 보존 — decode 가 원본 w:pPr 를 되살리는 데 필요
  const pp = el.getAttribute("data-pp");
  const ppAttr = pp ? ` data-pp="${escapeAttr(pp)}"` : "";
  return `<${outTag} class="${classFromStyleKey(styleKey)}"${ppAttr}>${serializeInline(el, ctx)}</${outTag}>`;
}

/** 블록 레벨의 떠도는 텍스트 → 본문 문단. */
function leafFromText(text: string, ctx: Ctx): string {
  const styleKey = ctx.palette.fallbackStyleKey;
  const outTag = htmlTagFromStyleKey(ctx.palette, styleKey);
  return `<${outTag} class="${classFromStyleKey(styleKey)}">${escapeHtml(text.trim())}</${outTag}>`;
}

/** class → styleKey, 없으면 태그로 추론, 그래도 없으면 fallback. */
function resolveStyleKey(el: HTMLElement, tagHint: string, ctx: Ctx): string {
  const cls = el.getAttribute("class");
  const fromClass = tryStyleKeyFromClass(ctx.palette, cls);
  if (fromClass) return fromClass;

  // 유효하지 않은 s- class 가 있었다면 "재매핑됨"으로 기록
  if (cls && /\bs-\S+/.test(cls)) ctx.report.remappedClasses.push(cls.trim());

  return styleKeyForHtmlTag(ctx.palette, tagHint) ?? ctx.palette.fallbackStyleKey;
}

function frozenBlock(el: HTMLElement): string {
  const refId = el.getAttribute("data-frozen") ?? "";
  const label = el.text.trim() || "[보존된 원본 요소]";
  return `<div class="s-frozen" data-frozen="${escapeAttr(refId)}" contenteditable="false">${escapeHtml(
    label,
  )}</div>`;
}

function cleanTable(el: HTMLElement, ctx: Ctx): string {
  const styleKey = tryStyleKeyFromClass(ctx.palette, el.getAttribute("class")) ?? ctx.palette.fallbackStyleKey;
  // 편집 가능 표의 원본 복원 토큰 — decode 가 셀을 원본 표에 갈아끼우는 데 필요(보존).
  const dataTable = el.getAttribute("data-table");
  const rows = el.querySelectorAll("tr").map((tr) => {
    const cells = tr.querySelectorAll("td,th").map((cell) => {
      countStyle(cell, ctx);
      const cKey = tryStyleKeyFromClass(ctx.palette, cell.getAttribute("class")) ?? ctx.palette.fallbackStyleKey;
      const colspan = cell.getAttribute("colspan");
      const rowspan = cell.getAttribute("rowspan");
      // data-cell(셀 식별자)·data-ro(읽기전용)는 보존 — 편집 가능 표 셀의 왕복 ref.
      const dataCell = cell.getAttribute("data-cell");
      const dataRo = cell.getAttribute("data-ro");
      const attrs =
        ` class="${classFromStyleKey(cKey)}"` +
        (dataCell ? ` data-cell="${escapeAttr(dataCell)}"` : "") +
        (dataRo !== null ? ` data-ro="${escapeAttr(dataRo ?? "")}"` : "") +
        (colspan ? ` colspan="${escapeAttr(colspan)}"` : "") +
        (rowspan ? ` rowspan="${escapeAttr(rowspan)}"` : "");
      return `<td${attrs}>${serializeInline(cell, ctx)}</td>`;
    });
    return `<tr>${cells.join("")}</tr>`;
  });
  const dtAttr = dataTable ? ` data-table="${escapeAttr(dataTable)}"` : "";
  return `<table class="${classFromStyleKey(styleKey)}"${dtAttr}><tbody>${rows.join("")}</tbody></table>`;
}

// ── 인라인 정규화 ────────────────────────────────────────────────────────

function serializeInline(node: HTMLElement, ctx: Ctx): string {
  let out = "";
  for (const child of node.childNodes) {
    if (child.nodeType === TEXT) {
      out += escapeHtml(child.text);
      continue;
    }
    if (child.nodeType !== ELEMENT) continue;

    const el = child as HTMLElement;
    const tag = el.tagName.toLowerCase();
    countStyle(el, ctx);

    if (tag === "br") {
      out += "<br/>";
      continue;
    }
    if (tag === "script" || tag === "style") {
      ctx.report.removedTags.push(tag);
      continue; // 내용째 제거
    }
    const mark = INLINE_MARK_TAGS[tag];
    if (mark) {
      out += `<${mark}>${serializeInline(el, ctx)}</${mark}>`;
    } else if (tag === "span" && el.getAttribute("data-frozen-run")) {
      // frozen 런(이미지·도형) 자리표시자 보존 — decode 가 원본 복원에 사용
      const ref = escapeAttr(el.getAttribute("data-frozen-run")!);
      out += `<span data-frozen-run="${ref}" contenteditable="false">${escapeHtml(el.text || "[개체]")}</span>`;
    } else if (tag === "span" && el.getAttribute("data-rp")) {
      // 런 직접서식 토큰(data-rp)을 실은 스팬은 보존 — decode 가 원본 w:rPr 복원에 사용
      out += `<span data-rp="${escapeAttr(el.getAttribute("data-rp")!)}">${serializeInline(el, ctx)}</span>`;
    } else {
      // span 등 알 수 없는 인라인/블록 래퍼 → 언랩(텍스트 보존)
      if (tag !== "span") ctx.report.removedTags.push(tag);
      out += serializeInline(el, ctx);
    }
  }
  return out;
}

// ── 유틸 ──────────────────────────────────────────────────────────────────

function countStyle(el: HTMLElement, ctx: Ctx): void {
  if (el.getAttribute("style")) ctx.report.strippedInlineStyles++;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}
