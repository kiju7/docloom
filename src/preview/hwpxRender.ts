/**
 * HWPX 리치 미리보기 렌더러 — 원본 충실도 목표.
 *
 * 섹션 XML 을 순회해 문단·표·그림·머릿말/꼬리말을 HTML 로 렌더하고, header.xml 서식
 * (글자색·크기·글꼴·정렬·표 테두리/배경)을 인라인 스타일로 입힌다. 용지/여백은 hp:pagePr
 * 에서 읽어 docx 와 같은 페이지 레이아웃 엔진(toPagedHtml)으로 시트 분할한다.
 */
import {
  type XmlNode,
  parseXml,
  tagOf,
  childrenOf,
  textOf,
  attrOf,
  findChild,
  findChildren,
  findDeep,
} from "../core/xml.js";
import { partToText, tryPartToText } from "../core/zip.js";
import type { Palette } from "../palette/palette.js";
import { classFromStyleKey, htmlTagFromStyleKey, styleKeyFromDocxId } from "../palette/palette.js";
import { bytesToBase64 } from "../core/base64.js";
import { HEADER_PART, listSectionPaths, findSectionRoot, findParagraphs, readParaStyleRef } from "../hwpx/owpml.js";
import { parseHwpxStyles, parseFontMap, type HwpxStyles, type BorderFill } from "../hwpx/styles.js";
import type { RenderResult, SectionProps } from "./render.js";

const HU = 96 / 7200; // HWPUNIT → px

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

interface Ctx {
  parts: Record<string, Uint8Array>;
  palette: Palette;
  styles: HwpxStyles;
  fonts: Map<string, string>;
}

/** HWPX zip 파트 → 페이지 렌더용 RenderResult. */
export function renderHwpxResult(parts: Record<string, Uint8Array>, palette: Palette): RenderResult {
  const headerXml = tryPartToText(parts, HEADER_PART);
  const ctx: Ctx = { parts, palette, styles: parseHwpxStyles(headerXml), fonts: parseFontMap(headerXml) };

  const sectionPaths = listSectionPaths(parts);
  const bodies: string[] = [];
  let header = "";
  let footer = "";
  let section: SectionProps | undefined;

  for (const path of sectionPaths) {
    const root = findSectionRoot(parseXml(partToText(parts, path)));
    if (!section) section = pageFromSection(root);
    const hf = headerFooter(root, ctx);
    if (!header && hf.header) header = hf.header;
    if (!footer && hf.footer) footer = hf.footer;
    for (const p of findParagraphs(root)) bodies.push(renderParagraph(p, ctx));
  }

  return { body: bodies.join("\n"), header, footer, section: section ?? defaultSection() };
}

// ── 페이지 기하 ─────────────────────────────────────────────────────────────

const SECTION_EXTRA = {
  orient: "portrait" as const,
  gutterPx: 0,
  titlePg: false,
  headerRefs: {},
  footerRefs: {},
};

function defaultSection(): SectionProps {
  return {
    page: { wPx: 794, hPx: 1123, topPx: 76, rightPx: 113, bottomPx: 57, leftPx: 113, headerPx: 57, footerPx: 57 },
    cols: { num: 1, space: 10, sep: false },
    ...SECTION_EXTRA,
  };
}

function pageFromSection(root: XmlNode): SectionProps {
  const pagePr = findDeep(childrenOf(root), "hp:pagePr");
  if (!pagePr) return defaultSection();
  const margin = findChild(childrenOf(pagePr), "hp:margin");
  const w = Number(attrOf(pagePr, "width")) || 59528;
  const h = Number(attrOf(pagePr, "height")) || 84186;
  const m = (n: string, d: number) => (margin ? Number(attrOf(margin, n)) || d : d);
  return {
    page: {
      wPx: Math.round(w * HU),
      hPx: Math.round(h * HU),
      leftPx: Math.round(m("left", 8504) * HU),
      rightPx: Math.round(m("right", 8504) * HU),
      topPx: Math.round(m("top", 5668) * HU),
      bottomPx: Math.round(m("bottom", 4252) * HU),
      headerPx: Math.round(m("header", 4252) * HU),
      footerPx: Math.round(m("footer", 4252) * HU),
    },
    cols: { num: 1, space: 10, sep: false },
    ...SECTION_EXTRA,
  };
}

// ── 머릿말/꼬리말 ────────────────────────────────────────────────────────────

function headerFooter(root: XmlNode, ctx: Ctx): { header: string; footer: string } {
  const h = findDeep(childrenOf(root), "hp:header");
  const f = findDeep(childrenOf(root), "hp:footer");
  const render = (node: XmlNode | undefined): string => {
    if (!node) return "";
    const sub = findDeep(childrenOf(node), "hp:subList");
    const paras = sub ? findChildren(childrenOf(sub), "hp:p") : [];
    return paras.map((p) => renderParagraph(p, ctx)).join("");
  };
  return { header: render(h), footer: render(f) };
}

// ── 문단 ────────────────────────────────────────────────────────────────────

function renderParagraph(p: XmlNode, ctx: Ctx): string {
  const styleKey = styleKeyFromDocxId(ctx.palette, readParaStyleRef(p));
  const tag = htmlTagFromStyleKey(ctx.palette, styleKey);
  const cls = classFromStyleKey(styleKey);
  const align = ctx.styles.align.get(attrOf(p, "paraPrIDRef") ?? "");
  const style = align && align !== "justify" ? ` style="text-align:${align}"` : align === "justify" ? ` style="text-align:justify"` : "";

  let inline = "";
  const blocks: string[] = [];
  for (const run of findChildren(childrenOf(p), "hp:run")) {
    const cp = ctx.styles.charPr.get(attrOf(run, "charPrIDRef") ?? "");
    for (const child of childrenOf(run)) {
      switch (tagOf(child)) {
        case "hp:t":
          inline += renderText(child, cp, ctx);
          break;
        case "hp:tbl":
          blocks.push(renderTable(child, ctx));
          break;
        case "hp:pic":
        case "hp:picture":
          blocks.push(renderPic(child, ctx));
          break;
        default:
          break;
      }
    }
  }

  const para = inline.trim() || blocks.length === 0 ? `<${tag} class="${cls}"${style}>${inline || "<br/>"}</${tag}>` : "";
  return [para, ...blocks].filter(Boolean).join("\n");
}

/** hp:t (텍스트 + 줄바꿈 hp:lineBreak) → 인라인 HTML(글자 서식 적용). */
function renderText(t: XmlNode, cp: ReturnType<HwpxStyles["charPr"]["get"]>, _ctx: Ctx): string {
  let s = "";
  for (const c of childrenOf(t)) {
    const tx = textOf(c);
    if (tx !== undefined) s += esc(tx);
    else if (tagOf(c) === "hp:lineBreak") s += "<br/>";
    else if (tagOf(c) === "hp:tab") s += "<span class=\"docloom-tab\"></span>";
  }
  if (!s) return "";
  let html = s;
  if (cp?.bold) html = `<strong>${html}</strong>`;
  if (cp?.italic) html = `<em>${html}</em>`;
  if (cp?.underline) html = `<u>${html}</u>`;
  if (cp?.strike) html = `<s>${html}</s>`;
  const style = charStyle(cp, _ctx);
  return style ? `<span style="${style}">${html}</span>` : html;
}

function charStyle(cp: ReturnType<HwpxStyles["charPr"]["get"]>, ctx: Ctx): string {
  if (!cp) return "";
  const parts: string[] = [];
  if (cp.sizePt) parts.push(`font-size:${cp.sizePt}pt`);
  if (cp.color) parts.push(`color:${cp.color}`);
  const font = cp.font ? ctx.fonts.get(cp.font) : undefined;
  if (font) parts.push(`font-family:'${font.replace(/'/g, "")}',sans-serif`);
  return parts.join(";");
}

// ── 표 ──────────────────────────────────────────────────────────────────────

function renderTable(tbl: XmlNode, ctx: Ctx): string {
  const rows: string[] = [];
  for (const tr of findChildren(childrenOf(tbl), "hp:tr")) {
    const cells: string[] = [];
    for (const tc of findChildren(childrenOf(tr), "hp:tc")) {
      const span = findChild(childrenOf(tc), "hp:cellSpan");
      const colSpan = span ? Number(attrOf(span, "colSpan") ?? "1") : 1;
      const rowSpan = span ? Number(attrOf(span, "rowSpan") ?? "1") : 1;
      const sub = findChild(childrenOf(tc), "hp:subList");
      const vAlign = sub ? (attrOf(sub, "vertAlign") ?? "").toLowerCase() : "";
      const inner = sub ? findChildren(childrenOf(sub), "hp:p").map((p) => renderParagraph(p, ctx)).join("") : "";
      const bf = ctx.styles.borderFill.get(attrOf(tc, "borderFillIDRef") ?? "");
      const style = cellStyle(bf, vAlign);
      const attrs =
        `${colSpan > 1 ? ` colspan="${colSpan}"` : ""}${rowSpan > 1 ? ` rowspan="${rowSpan}"` : ""}` +
        (style ? ` style="${style}"` : "");
      cells.push(`<td${attrs}>${inner}</td>`);
    }
    rows.push(`<tr>${cells.join("")}</tr>`);
  }
  return `<table class="docloom-table hwp-table"><tbody>${rows.join("")}</tbody></table>`;
}

function cellStyle(bf: BorderFill | undefined, vAlign: string): string {
  const parts: string[] = [];
  if (bf) {
    const b = (name: "left" | "right" | "top" | "bottom") => {
      const x = bf[name];
      parts.push(`border-${name}:${x.width > 0 ? `${x.width}px solid ${x.color}` : "none"}`);
    };
    b("left");
    b("right");
    b("top");
    b("bottom");
    if (bf.bg) parts.push(`background:${bf.bg}`);
  }
  if (vAlign === "center" || vAlign === "top" || vAlign === "bottom") parts.push(`vertical-align:${vAlign === "center" ? "middle" : vAlign}`);
  return parts.join(";");
}

// ── 그림 ────────────────────────────────────────────────────────────────────

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
  svg: "image/svg+xml",
};

function renderPic(pic: XmlNode, ctx: Ctx): string {
  const img = findDeep(childrenOf(pic), "hp:img");
  const ref = img ? attrOf(img, "binaryItemIDRef") : undefined;
  const uri = ref ? binDataUri(ctx.parts, ref) : undefined;
  // 크기: hp:sz / hp:orgSz (HWPUNIT)
  const sz = findDeep(childrenOf(pic), "hp:sz") ?? findDeep(childrenOf(pic), "hp:orgSz");
  const w = sz ? Number(attrOf(sz, "width")) : NaN;
  const dim = Number.isFinite(w) && w > 0 ? ` style="width:${Math.round(w * HU)}px;max-width:100%"` : "";
  if (uri) return `<img class="docloom-img" src="${uri}"${dim} alt="그림"/>`;
  return `<div class="s-frozen">[그림]</div>`;
}

function binDataUri(parts: Record<string, Uint8Array>, idRef: string): string | undefined {
  const candidates = Object.keys(parts).filter((p) => p.startsWith("BinData/"));
  const match =
    candidates.find((p) => p.replace(/^BinData\//, "").replace(/\.[^.]+$/, "").toLowerCase() === idRef.toLowerCase()) ??
    candidates.find((p) => p.toLowerCase().includes(idRef.toLowerCase()));
  if (!match) return undefined;
  const ext = match.split(".").pop()?.toLowerCase() ?? "";
  const mime = MIME[ext];
  if (!mime) return undefined;
  return `data:${mime};base64,${bytesToBase64(parts[match]!)}`;
}
