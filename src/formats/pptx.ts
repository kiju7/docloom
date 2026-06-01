/**
 * pptx 포맷 어댑터 — 미리보기(읽기) 전용. 왕복(encode/decode)은 로드맵.
 *
 * 슬라이드를 원본처럼 보이게 렌더한다:
 *   - 슬라이드 크기(p:sldSz, EMU) → 고정 캔버스(px).
 *   - 도형(p:sp)·그림(p:pic)·표(p:graphicFrame>a:tbl)를 a:xfrm(off/ext, EMU)으로 절대 위치.
 *   - xfrm 없는 플레이스홀더는 slideLayout → slideMaster 에서 위치를 상속.
 *   - 텍스트 서식(크기·색·볼드·정렬·글머리·들여쓰기)은 master txStyles → master/layout 플레이스홀더
 *     lstStyle → 도형 lstStyle → 문단 pPr → 런 rPr 순으로 상속·병합한다.
 *   - 색은 srgbClr/schemeClr + lumMod/lumOff/shade/tint(회색 등 명암 변형) 해석.
 *   - 그림은 rels 로 미디어를 찾아 data URI(png/jpg/gif/bmp/svg), emf/wmf 는 자리표시자.
 * 한계: 그룹 변환·도형 효과·자동번호 세부 형식은 근사. (왕복 아님 — 보기 전용)
 */
import type { FormatAdapter } from "../core/format.js";
import { readZip, tryPartToText } from "../core/zip.js";
import { encodePptxToHtml } from "../encode/pptxToHtml.js";
import { decodeHtmlToPptx } from "../decode/htmlToPptx.js";
import { parseXml, collectDeep, deepText, childrenOf, findChild, findChildren, findDeep, attrOf, type XmlNode } from "../core/xml.js";
import { toPreviewHtml, type PreviewOptions } from "../preview/preview.js";
import { bytesToBase64 } from "../core/base64.js";
import { tiffToPngDataUri } from "../core/tiff.js";

const EMU = 9525; // EMU per px (96dpi)
const px = (v: string | number | undefined): number => Math.round(Number(v ?? 0) / EMU);
const tagOf = (n: XmlNode): string => Object.keys(n)[0] ?? "";

interface Box { x: number; y: number; w: number; h: number }

const IMG_MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", bmp: "image/bmp", svg: "image/svg+xml",
};

// ── 경로/관계 ──────────────────────────────────────────────────────────────

function resolvePath(fromPart: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const out: string[] = [];
  for (const seg of (fromPart.split("/").slice(0, -1).join("/") + "/" + target).split("/")) {
    if (seg === "..") out.pop();
    else if (seg !== "." && seg !== "") out.push(seg);
  }
  return out.join("/");
}
function relsPathFor(part: string): string {
  const i = part.lastIndexOf("/");
  return `${part.slice(0, i)}/_rels${part.slice(i)}.rels`;
}
type Rels = Map<string, { target: string; type: string }>;
function readRels(parts: Record<string, Uint8Array>, relsPath: string): Rels {
  const m: Rels = new Map();
  const xml = tryPartToText(parts, relsPath);
  if (!xml) return m;
  for (const rel of collectDeep(parseXml(xml), "Relationship")) {
    const id = attrOf(rel, "Id");
    const t = attrOf(rel, "Target");
    if (id && t) m.set(id, { target: t, type: attrOf(rel, "Type") ?? "" });
  }
  return m;
}

// ── 슬라이드 순서 ────────────────────────────────────────────────────────────

function slidePaths(parts: Record<string, Uint8Array>): string[] {
  const pres = tryPartToText(parts, "ppt/presentation.xml");
  const rels = readRels(parts, "ppt/_rels/presentation.xml.rels");
  if (pres) {
    const ordered = collectDeep(parseXml(pres), "p:sldId")
      .map((n) => attrOf(n, "r:id"))
      .map((id) => (id ? rels.get(id)?.target : undefined))
      .filter((t): t is string => !!t)
      .map((t) => resolvePath("ppt/presentation.xml", t));
    if (ordered.length) return ordered;
  }
  return Object.keys(parts)
    .filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
    .sort((a, b) => Number(/slide(\d+)/.exec(a)![1]) - Number(/slide(\d+)/.exec(b)![1]));
}

// ── xfrm / 플레이스홀더 ──────────────────────────────────────────────────────

function boxOf(xfrm: XmlNode | undefined): Box | undefined {
  if (!xfrm) return undefined;
  const off = findChild(childrenOf(xfrm), "a:off");
  const ext = findChild(childrenOf(xfrm), "a:ext");
  if (!off || !ext) return undefined;
  return { x: px(attrOf(off, "x")), y: px(attrOf(off, "y")), w: px(attrOf(ext, "cx")), h: px(attrOf(ext, "cy")) };
}
function shapeBox(node: XmlNode): Box | undefined {
  const spPr = findChild(childrenOf(node), "p:spPr");
  const xfrm = (spPr && findChild(childrenOf(spPr), "a:xfrm")) || findChild(childrenOf(node), "p:xfrm");
  return boxOf(xfrm);
}
function phOf(node: XmlNode): { type?: string; idx?: string } | undefined {
  const ph = findDeep([node], "p:ph");
  if (!ph) return undefined;
  return { type: attrOf(ph, "type"), idx: attrOf(ph, "idx") };
}
function placeholderBoxes(parts: Record<string, Uint8Array>, partPath: string | undefined): Map<string, Box> {
  const map = new Map<string, Box>();
  const xml = partPath ? tryPartToText(parts, partPath) : undefined;
  if (!xml) return map;
  for (const sp of collectDeep(parseXml(xml), "p:sp")) {
    const ph = phOf(sp);
    const box = shapeBox(sp);
    if (!ph || !box) continue;
    if (ph.type) map.set("type:" + ph.type, box);
    if (ph.idx) map.set("idx:" + ph.idx, box);
  }
  return map;
}
const TITLE_ALIASES = ["title", "ctrTitle"];
function phKeys(ph: { type?: string; idx?: string }): string[] {
  const keys: string[] = [];
  if (ph.type) {
    keys.push("type:" + ph.type);
    if (TITLE_ALIASES.includes(ph.type)) for (const a of TITLE_ALIASES) keys.push("type:" + a);
  }
  if (ph.idx) keys.push("idx:" + ph.idx);
  return keys;
}
function resolveBox(node: XmlNode, layout: Map<string, Box>, master: Map<string, Box>): Box | undefined {
  const direct = shapeBox(node);
  if (direct) return direct;
  const ph = phOf(node);
  if (!ph) return undefined;
  for (const m of [layout, master]) for (const k of phKeys(ph)) if (m.has(k)) return m.get(k);
  return undefined;
}

// ── 색 (srgb/scheme + lumMod/lumOff/shade/tint) ──────────────────────────────

const SCHEME_MAP: Record<string, string> = { tx1: "dk1", tx2: "dk2", bg1: "lt1", bg2: "lt2" };
function clamp(v: number): number { return Math.max(0, Math.min(255, Math.round(v))); }
function colorOf(clr: XmlNode | undefined, theme: Record<string, string>): string | undefined {
  if (!clr) return undefined;
  let hex: string | undefined;
  if (tagOf(clr) === "a:srgbClr") hex = attrOf(clr, "val");
  else if (tagOf(clr) === "a:schemeClr" || tagOf(clr) === "a:sysClr") {
    const v = attrOf(clr, "val") ?? "";
    hex = (theme[SCHEME_MAP[v] ?? v] ?? "").replace("#", "") || attrOf(clr, "lastClr");
  }
  if (!hex || hex.length < 6) return undefined;
  let r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16);
  for (const mod of childrenOf(clr)) {
    const t = tagOf(mod);
    const val = Number(attrOf(mod, "val")) / 100000;
    if (!Number.isFinite(val)) continue;
    if (t === "a:lumMod") { r *= val; g *= val; b *= val; }
    else if (t === "a:lumOff") { r += 255 * val; g += 255 * val; b += 255 * val; }
    else if (t === "a:shade") { r *= val; g *= val; b *= val; }
    else if (t === "a:tint") { r = r * val + 255 * (1 - val); g = g * val + 255 * (1 - val); b = b * val + 255 * (1 - val); }
  }
  const to2 = (v: number) => clamp(v).toString(16).padStart(2, "0");
  return "#" + (to2(r) + to2(g) + to2(b)).toUpperCase();
}
/** a:solidFill(또는 색 노드를 직접 품은 컨테이너) → CSS 색. */
function colorFromFill(fill: XmlNode | undefined, theme: Record<string, string>): string | undefined {
  if (!fill) return undefined;
  const clr = findChild(childrenOf(fill), "a:srgbClr") ?? findChild(childrenOf(fill), "a:schemeClr") ?? findChild(childrenOf(fill), "a:sysClr");
  return colorOf(clr, theme);
}

function themePalette(parts: Record<string, Uint8Array>, masterPath: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!masterPath) return out;
  const masterRels = readRels(parts, relsPathFor(masterPath));
  const themeTarget = [...masterRels.values()].find((r) => r.type.includes("theme"))?.target;
  const themeXml = themeTarget ? tryPartToText(parts, resolvePath(masterPath, themeTarget)) : undefined;
  if (!themeXml) return out;
  const m = themeXml.match(/<a:clrScheme[\s\S]*?<\/a:clrScheme>/);
  if (!m) return out;
  const re = /<a:(\w+)>\s*<a:(srgbClr|sysClr)[^>]*?(?:val|lastClr)="([0-9A-Fa-f]{6})"/g;
  let mm: RegExpExecArray | null;
  while ((mm = re.exec(m[0]))) out[mm[1]!] = "#" + mm[3]!.toUpperCase();
  return out;
}

// ── 텍스트 스타일(레벨별 상속) ───────────────────────────────────────────────

const ALIGN: Record<string, string> = { l: "left", ctr: "center", r: "right", just: "justify" };

function lighten(hex: string, t: number): string {
  const h = hex.replace("#", "");
  const ch = (i: number) => parseInt(h.substr(i, 2), 16);
  const mix = (v: number) => Math.round(v + (255 - v) * t);
  const to2 = (v: number) => v.toString(16).padStart(2, "0");
  return "#" + to2(mix(ch(0))) + to2(mix(ch(2))) + to2(mix(ch(4)));
}

interface RunStyle { sizePt?: number; bold?: boolean; italic?: boolean; underline?: boolean; color?: string }
interface Bullet { kind: "char" | "num" | "none"; char?: string; font?: string }
interface LvlStyle { algn?: string; marL?: number; indent?: number; bullet?: Bullet; rPr: RunStyle }
type LvlStyles = LvlStyle[]; // index = level(0-based)
type TxStyles = { title: LvlStyles; body: LvlStyles; other: LvlStyles };

function readRunStyle(rPr: XmlNode | undefined, theme: Record<string, string>): RunStyle {
  const s: RunStyle = {};
  if (!rPr) return s;
  const sz = Number(attrOf(rPr, "sz"));
  if (Number.isFinite(sz)) s.sizePt = sz / 100;
  const b = attrOf(rPr, "b");
  if (b === "1") s.bold = true; else if (b === "0") s.bold = false;
  if (attrOf(rPr, "i") === "1") s.italic = true;
  const u = attrOf(rPr, "u");
  if (u && u !== "none") s.underline = true;
  const color = colorFromFill(findChild(childrenOf(rPr), "a:solidFill"), theme);
  if (color) s.color = color;
  return s;
}
function readLvlPr(pPr: XmlNode | undefined, theme: Record<string, string>): LvlStyle {
  const out: LvlStyle = { rPr: {} };
  if (!pPr) return out;
  const algn = ALIGN[attrOf(pPr, "algn") ?? ""];
  if (algn) out.algn = algn;
  const marL = Number(attrOf(pPr, "marL"));
  if (Number.isFinite(marL)) out.marL = px(marL);
  const indent = Number(attrOf(pPr, "indent"));
  if (Number.isFinite(indent)) out.indent = px(indent);
  const kids = childrenOf(pPr);
  if (findChild(kids, "a:buNone")) out.bullet = { kind: "none" };
  else if (findChild(kids, "a:buAutoNum")) out.bullet = { kind: "num" };
  else {
    const bc = findChild(kids, "a:buChar");
    if (bc) {
      // buFont(Wingdings 등 심볼폰트)을 마커에 적용해야 §/Ø/ü 가 사각·화살표·체크로 보인다.
      const bf = findChild(kids, "a:buFont");
      out.bullet = { kind: "char", char: attrOf(bc, "char") ?? "•", font: bf ? attrOf(bf, "typeface") : undefined };
    }
  }
  out.rPr = readRunStyle(findChild(kids, "a:defRPr"), theme);
  return out;
}
/** a:lstStyle 또는 p:txStyles 의 카테고리 노드 → 9레벨 스타일. */
function readLevels(container: XmlNode | undefined, theme: Record<string, string>): LvlStyles {
  const arr: LvlStyles = [];
  if (!container) return arr;
  const kids = childrenOf(container);
  for (let i = 1; i <= 9; i++) arr[i - 1] = readLvlPr(findChild(kids, `a:lvl${i}pPr`), theme);
  return arr;
}
function masterTxStyles(parts: Record<string, Uint8Array>, masterPath: string | undefined, theme: Record<string, string>): TxStyles {
  const empty: TxStyles = { title: [], body: [], other: [] };
  const xml = masterPath ? tryPartToText(parts, masterPath) : undefined;
  if (!xml) return empty;
  const txs = findDeep(parseXml(xml), "p:txStyles");
  if (!txs) return empty;
  const k = childrenOf(txs);
  return {
    title: readLevels(findChild(k, "p:titleStyle"), theme),
    body: readLevels(findChild(k, "p:bodyStyle"), theme),
    other: readLevels(findChild(k, "p:otherStyle"), theme),
  };
}
/** layout/master 의 플레이스홀더별 lstStyle(부제 buNone·회색 글자색 등이 여기 있다). */
function placeholderLstStyles(parts: Record<string, Uint8Array>, partPath: string | undefined, theme: Record<string, string>): Map<string, LvlStyles> {
  const map = new Map<string, LvlStyles>();
  const xml = partPath ? tryPartToText(parts, partPath) : undefined;
  if (!xml) return map;
  for (const sp of collectDeep(parseXml(xml), "p:sp")) {
    const ph = phOf(sp);
    if (!ph) continue;
    const tx = findDeep([sp], "p:txBody");
    const list = tx ? findChild(childrenOf(tx), "a:lstStyle") : undefined;
    if (!list) continue;
    const levels = readLevels(list, theme);
    if (ph.type) map.set("type:" + ph.type, levels);
    if (ph.idx) map.set("idx:" + ph.idx, levels);
  }
  return map;
}
function styleCategory(node: XmlNode): keyof TxStyles {
  const t = phOf(node)?.type;
  if (t === "title" || t === "ctrTitle") return "title";
  if (t !== undefined) return "body";
  return "other";
}
function phLayer(map: Map<string, LvlStyles>, ph: { type?: string; idx?: string } | undefined): LvlStyles | undefined {
  if (!ph) return undefined;
  for (const k of phKeys(ph)) if (map.has(k)) return map.get(k);
  return undefined;
}

function mergeRun(base: RunStyle, over: RunStyle): RunStyle { return { ...base, ...over }; }
function mergeLvl(a: LvlStyle, b: LvlStyle): LvlStyle {
  return {
    algn: b.algn ?? a.algn,
    marL: b.marL ?? a.marL,
    indent: b.indent ?? a.indent,
    bullet: b.bullet ?? a.bullet,
    rPr: mergeRun(a.rPr, b.rPr),
  };
}
function runStyleCss(s: RunStyle): string {
  const d: string[] = [];
  if (s.sizePt) d.push(`font-size:${s.sizePt}pt`);
  if (s.bold) d.push("font-weight:bold");
  if (s.italic) d.push("font-style:italic");
  if (s.underline) d.push("text-decoration:underline");
  if (s.color) d.push(`color:${s.color}`);
  return d.join(";");
}

/** layers = 상속 레이어(낮은→높은 우선순위). dropColor=true 면 상속 글자색 무시(표 셀). */
function renderTextBody(node: XmlNode, layers: LvlStyles[], theme: Record<string, string>, dropColor = false): string {
  const tx = findChild(childrenOf(node), "p:txBody") ?? findChild(childrenOf(node), "a:txBody");
  if (!tx) return "";
  const txKids = childrenOf(tx);
  const ownList = findChild(txKids, "a:lstStyle");
  const counters: number[] = [];
  let out = "";
  for (const p of findChildren(txKids, "a:p")) {
    const pPr = findChild(childrenOf(p), "a:pPr");
    const lvl = Number(attrOf(pPr ?? {}, "lvl") ?? "0") || 0;
    let eff: LvlStyle = { rPr: {} };
    for (const layer of layers) { const L = layer[lvl]; if (L) eff = mergeLvl(eff, L); }
    if (ownList) eff = mergeLvl(eff, readLvlPr(findChild(childrenOf(ownList), `a:lvl${lvl + 1}pPr`), theme));
    eff = mergeLvl(eff, readLvlPr(pPr, theme));
    if (dropColor) eff.rPr = { ...eff.rPr, color: undefined };

    let inner = "";
    for (const n of childrenOf(p)) {
      const tag = tagOf(n);
      if (tag === "a:r") {
        const text = esc(deepText(findChild(childrenOf(n), "a:t") ?? {}));
        if (!text) continue;
        const css = runStyleCss(mergeRun(eff.rPr, readRunStyle(findChild(childrenOf(n), "a:rPr"), theme)));
        inner += css ? `<span style="${css}">${text}</span>` : text;
      } else if (tag === "a:br") inner += "<br/>";
      else if (tag === "a:fld") inner += esc(deepText(findChild(childrenOf(n), "a:t") ?? {}));
    }

    let marker = "";
    const bul = eff.bullet;
    if (inner && bul && bul.kind !== "none") {
      if (bul.kind === "char") {
        const bf = bul.font ? ` style="font-family:'${bul.font.replace(/'/g, "")}'"` : "";
        marker = `<span class="pptx-bul"${bf}>${esc(bul.char ?? "•")}</span>`;
      } else { counters[lvl] = (counters[lvl] ?? 0) + 1; marker = `<span class="pptx-bul">${counters[lvl]}.</span>`; }
    }
    if (!inner) inner = "&#8203;";
    const d: string[] = [];
    if (eff.algn) d.push(`text-align:${eff.algn}`);
    if (eff.marL) d.push(`padding-left:${eff.marL}px`);
    if (eff.indent) d.push(`text-indent:${eff.indent}px`);
    // 문단 기준 글자크기 — 빈 문단(blank line)이 상속 기본(예 18pt)·브라우저 16px 로 부풀어
    // 박스를 넘쳐 잘리던 문제 해결. **endParaRPr 우선**(문단끝 마크가 빈 줄 높이를 정의),
    // 없으면 상속 defRPr. 런이 있는 줄은 런 span 이 제 크기로 덮으므로 안전.
    const endPr = findChild(childrenOf(p), "a:endParaRPr");
    const pSize = readRunStyle(endPr, theme).sizePt ?? eff.rPr.sizePt;
    if (pSize) d.push(`font-size:${pSize}pt`);
    // 줄간격: a:lnSpc(spcPct 비율 또는 spcPts 고정pt) 반영(무시하면 너무 성겨 넘침).
    const lnSpc = pPr ? findChild(childrenOf(pPr), "a:lnSpc") : undefined;
    if (lnSpc) {
      const pct = findChild(childrenOf(lnSpc), "a:spcPct");
      const pts = findChild(childrenOf(lnSpc), "a:spcPts");
      if (pct) { const v = Number(attrOf(pct, "val")); if (Number.isFinite(v)) d.push(`line-height:${(v / 100000).toFixed(3)}`); }
      else if (pts) { const v = Number(attrOf(pts, "val")); if (Number.isFinite(v)) d.push(`line-height:${(v / 100).toFixed(1)}pt`); }
    }
    const style = d.length ? ` style="${d.join(";")}"` : "";
    out += `<p${style}>${marker}${inner}</p>`;
  }
  return out;
}

// ── 표 ───────────────────────────────────────────────────────────────────────

interface PartStyle { fill?: string; bold?: boolean; color?: string }
interface TblStyle { wholeTbl?: PartStyle; firstRow?: PartStyle; lastRow?: PartStyle; band1H?: PartStyle; band2H?: PartStyle; firstCol?: PartStyle }
function readPartStyle(node: XmlNode | undefined, theme: Record<string, string>): PartStyle | undefined {
  if (!node) return undefined;
  const kids = childrenOf(node);
  const p: PartStyle = {};
  const tcStyle = findChild(kids, "a:tcStyle");
  const fillNode = tcStyle ? findChild(childrenOf(tcStyle), "a:fill") : undefined;
  const solid = fillNode ? findChild(childrenOf(fillNode), "a:solidFill") : undefined;
  if (solid) p.fill = colorFromFill(solid, theme);
  const txStyle = findChild(kids, "a:tcTxStyle");
  if (txStyle) {
    if (attrOf(txStyle, "b") === "on") p.bold = true;
    const c = colorFromFill(txStyle, theme);
    if (c) p.color = c;
  }
  return Object.keys(p).length ? p : undefined;
}
function parseTableStyles(parts: Record<string, Uint8Array>, theme: Record<string, string>): Map<string, TblStyle> {
  const map = new Map<string, TblStyle>();
  const xml = tryPartToText(parts, "ppt/tableStyles.xml");
  if (!xml) return map;
  for (const st of collectDeep(parseXml(xml), "a:tblStyle")) {
    const id = attrOf(st, "styleId");
    if (!id) continue;
    const k = childrenOf(st);
    map.set(id, {
      wholeTbl: readPartStyle(findChild(k, "a:wholeTbl"), theme),
      firstRow: readPartStyle(findChild(k, "a:firstRow"), theme),
      lastRow: readPartStyle(findChild(k, "a:lastRow"), theme),
      band1H: readPartStyle(findChild(k, "a:band1H"), theme),
      band2H: readPartStyle(findChild(k, "a:band2H"), theme),
      firstCol: readPartStyle(findChild(k, "a:firstCol"), theme),
    });
  }
  return map;
}
function renderTbl(frame: XmlNode, theme: Record<string, string>, tableStyles: Map<string, TblStyle>, txStyles: TxStyles): string {
  const tbl = findDeep([frame], "a:tbl");
  if (!tbl) return "";
  const tblPr = findChild(childrenOf(tbl), "a:tblPr");
  const flagFirstRow = attrOf(tblPr ?? {}, "firstRow") === "1";
  const flagLastRow = attrOf(tblPr ?? {}, "lastRow") === "1";
  const flagBand = attrOf(tblPr ?? {}, "bandRow") === "1";
  const styleId = (tblPr ? deepText(findChild(childrenOf(tblPr), "a:tableStyleId") ?? {}) : "").trim();
  // 널 GUID({0000-...-0000})는 "스타일 없음"(투명) — accent 합성 금지(원본에 없는 파란배경 방지).
  const nullStyle = !styleId || /^\{0+-0+-0+-0+-0+\}$/.test(styleId);
  let ts = (styleId && tableStyles.get(styleId)) || undefined;
  // 내장 표 스타일은 파일에 정의가 없다(tableStyles.xml 빈 껍데기). 실 styleId+플래그면 테마 accent 로 근사.
  if (!nullStyle && (!ts || (!ts.firstRow && !ts.band1H && !ts.wholeTbl)) && (flagFirstRow || flagBand)) {
    const accent = theme.accent1 ?? "#4472C4";
    ts = { firstRow: { fill: accent, color: "#FFFFFF", bold: true }, band1H: { fill: lighten(accent, 0.84) } };
  }

  const grid = findChild(childrenOf(tbl), "a:tblGrid");
  const colW = grid ? findChildren(childrenOf(grid), "a:gridCol").map((c) => px(attrOf(c, "w"))) : [];
  const cg = colW.map((w) => `<col style="width:${w}px"/>`).join("");

  const trs = findChildren(childrenOf(tbl), "a:tr");
  const layers = [txStyles.other];
  let rows = "";
  for (let r = 0; r < trs.length; r++) {
    const tr = trs[r]!;
    const h = px(attrOf(tr, "h"));
    let part: PartStyle | undefined = ts?.wholeTbl;
    const isFirst = flagFirstRow && r === 0;
    const isLast = flagLastRow && r === trs.length - 1;
    if (isFirst && ts?.firstRow) part = ts.firstRow;
    else if (isLast && ts?.lastRow) part = ts.lastRow;
    else if (flagBand && !isFirst) {
      const dataIdx = flagFirstRow ? r - 1 : r;
      part = (dataIdx % 2 === 0 ? ts?.band1H : ts?.band2H) ?? ts?.wholeTbl;
    }
    let cells = "";
    for (const tc of findChildren(childrenOf(tr), "a:tc")) {
      if (attrOf(tc, "hMerge") === "1" || attrOf(tc, "vMerge") === "1") continue;
      const gs = Number(attrOf(tc, "gridSpan"));
      const rs = Number(attrOf(tc, "rowSpan"));
      const span = (Number.isFinite(gs) && gs > 1 ? ` colspan="${gs}"` : "") + (Number.isFinite(rs) && rs > 1 ? ` rowspan="${rs}"` : "");
      const tcPr = findChild(childrenOf(tc), "a:tcPr");
      const cellKids = tcPr ? childrenOf(tcPr) : [];
      // 셀이 직접 noFill 이면 투명(스타일 채우기 무시). solidFill 이면 그 색. 둘 다 없으면 스타일 상속.
      const cellNoFill = !!findChild(cellKids, "a:noFill");
      const explicitFill = colorFromFill(findChild(cellKids, "a:solidFill"), theme);
      const bg = cellNoFill ? undefined : explicitFill ?? part?.fill;
      const d: string[] = [];
      if (bg) d.push(`background-color:${bg}`);
      if (part?.color) d.push(`color:${part.color}`);
      if (part?.bold) d.push("font-weight:bold");
      // 셀 테두리: a:tcPr 의 lnL/lnR/lnT/lnB 를 그대로 반영. 하나라도 정의돼 있으면
      // 미정의 변은 테두리 없음(PowerPoint 기본)으로 둬 기본 1px 격자를 덮는다.
      const kidsTc = tcPr ? childrenOf(tcPr) : [];
      const sides: [string, string][] = [["a:lnL", "left"], ["a:lnR", "right"], ["a:lnT", "top"], ["a:lnB", "bottom"]];
      if (sides.some(([t]) => findChild(kidsTc, t))) {
        for (const [t, css] of sides) d.push(`border-${css}:${lnCss(findChild(kidsTc, t), theme) ?? "none"}`);
      }
      const st = d.length ? ` style="${d.join(";")}"` : "";
      cells += `<td${span}${st}>${renderTextBody(tc, layers, theme, true) || "&#8203;"}</td>`;
    }
    // 행 높이는 최소값으로(내용이 많으면 늘어나 줄바꿈이 안 잘리게)
    rows += `<tr style="height:${h}px">${cells}</tr>`;
  }
  return `<table class="pptx-tbl"><colgroup>${cg}</colgroup><tbody>${rows}</tbody></table>`;
}

// ── 그림 ───────────────────────────────────────────────────────────────────────

function renderPic(node: XmlNode, parts: Record<string, Uint8Array>, slidePath: string, rels: Rels): string {
  const blip = findDeep([node], "a:blip");
  const embed = blip ? attrOf(blip, "r:embed") : undefined;
  const target = embed ? rels.get(embed)?.target : undefined;
  if (!target) return "";
  const mediaPath = resolvePath(slidePath, target);
  const buf = parts[mediaPath];
  const ext = (mediaPath.split(".").pop() ?? "").toLowerCase();
  const mime = IMG_MIME[ext];
  if (buf && mime) return `<img src="data:${mime};base64,${bytesToBase64(buf)}" style="width:100%;height:100%;object-fit:contain" alt=""/>`;
  // TIFF 는 브라우저가 못 그리므로 PNG 로 디코드(LZW/Deflate/PackBits/None).
  if (buf && (ext === "tif" || ext === "tiff")) {
    const uri = tiffToPngDataUri(buf);
    if (uri) return `<img src="${uri}" style="width:100%;height:100%;object-fit:contain" alt=""/>`;
  }
  return `<div class="pptx-ph-img">🖼<br/><small>${ext.toUpperCase()} 미표시</small></div>`;
}

// ── 채우기 / 윤곽선 / 도형형상 / 배경 ─────────────────────────────────────────

/** a:gradFill → 첫 그라데이션 스톱 색(폴백). */
function gradFirstColor(grad: XmlNode | undefined, theme: Record<string, string>): string | undefined {
  if (!grad) return undefined;
  const gsLst = findChild(childrenOf(grad), "a:gsLst");
  const gs = gsLst ? findChild(childrenOf(gsLst), "a:gs") : undefined;
  return colorFromFill(gs, theme);
}
/** a:gradFill → 진짜 CSS linear/radial-gradient(스톱·각도 보존). 스톱<2 면 undefined. */
function gradientCss(grad: XmlNode | undefined, theme: Record<string, string>): string | undefined {
  if (!grad) return undefined;
  const gsLst = findChild(childrenOf(grad), "a:gsLst");
  if (!gsLst) return undefined;
  const stops = findChildren(childrenOf(gsLst), "a:gs").map((gs) => {
    const pos = Number(attrOf(gs, "pos")) / 1000; // OOXML 1000분율 → %
    const clr = findChild(childrenOf(gs), "a:srgbClr") ?? findChild(childrenOf(gs), "a:schemeClr") ?? findChild(childrenOf(gs), "a:sysClr");
    const c = colorOf(clr, theme);
    return c && Number.isFinite(pos) ? `${c} ${Math.round(pos)}%` : undefined;
  }).filter((s): s is string => !!s);
  if (stops.length < 2) return undefined;
  if (findChild(childrenOf(grad), "a:path")) return `radial-gradient(circle,${stops.join(",")})`;
  const lin = findChild(childrenOf(grad), "a:lin");
  const ang = lin ? Number(attrOf(lin, "ang")) : 0;
  const deg = ((((Number.isFinite(ang) ? ang / 60000 : 0) + 90) % 360) + 360) % 360; // 동쪽0·시계방향 → CSS 북0
  return `linear-gradient(${Math.round(deg)}deg,${stops.join(",")})`;
}
/** spPr/bgPr 의 채우기 → CSS 값(색 또는 gradient). noFill → "none". `background:` 에 그대로 사용. */
function fillColorOf(container: XmlNode | undefined, theme: Record<string, string>): string | undefined {
  if (!container) return undefined;
  const kids = childrenOf(container);
  if (findChild(kids, "a:noFill")) return "none";
  const solid = findChild(kids, "a:solidFill");
  if (solid) return colorFromFill(solid, theme);
  const grad = findChild(kids, "a:gradFill");
  if (grad) return gradientCss(grad, theme) ?? gradFirstColor(grad, theme);
  return undefined;
}
/** 도형/그룹 회전각(도). spPr·grpSpPr 의 a:xfrm rot(60000분의1도) 또는 p:xfrm. 없으면 0. */
function rotOf(node: XmlNode): number {
  const pr = findChild(childrenOf(node), "p:spPr") ?? findChild(childrenOf(node), "p:grpSpPr");
  const xfrm = (pr && findChild(childrenOf(pr), "a:xfrm")) || findChild(childrenOf(node), "p:xfrm");
  const r = xfrm ? Number(attrOf(xfrm, "rot")) : 0;
  return Number.isFinite(r) && r ? r / 60000 : 0;
}
/** p:grpSp 의 슬라이드좌표 박스(grpSpPr off/ext 를 부모 XF 로 변환). 회전중심 계산용. */
function groupBoxSlide(parent: XF, node: XmlNode): Box | undefined {
  const gpr = findChild(childrenOf(node), "p:grpSpPr");
  const xfrm = gpr ? findChild(childrenOf(gpr), "a:xfrm") : undefined;
  const off = xfrm ? findChild(childrenOf(xfrm), "a:off") : undefined;
  const ext = xfrm ? findChild(childrenOf(xfrm), "a:ext") : undefined;
  if (!off || !ext) return undefined;
  return applyXF(parent, { x: px(attrOf(off, "x")), y: px(attrOf(off, "y")), w: px(attrOf(ext, "cx")), h: px(attrOf(ext, "cy")) });
}
function hexToRgba(hex: string, a: number): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, a)).toFixed(2)})`;
}
/** a:effectLst > a:outerShdw → CSS filter drop-shadow(절단형상·투명도 따름). 없으면 undefined. */
function shadowCss(node: XmlNode, theme: Record<string, string>): string | undefined {
  const spPr = findChild(childrenOf(node), "p:spPr");
  const eff = spPr ? findChild(childrenOf(spPr), "a:effectLst") : undefined;
  const sh = eff ? findChild(childrenOf(eff), "a:outerShdw") : undefined;
  if (!sh) return undefined;
  const blurPx = (Number(attrOf(sh, "blurRad")) || 0) / EMU;
  const distPx = (Number(attrOf(sh, "dist")) || 0) / EMU;
  const ang = ((Number(attrOf(sh, "dir")) || 0) / 60000) * Math.PI / 180; // 동쪽0·시계방향
  const ox = distPx * Math.cos(ang), oy = distPx * Math.sin(ang);
  const clr = findChild(childrenOf(sh), "a:srgbClr") ?? findChild(childrenOf(sh), "a:schemeClr") ?? findChild(childrenOf(sh), "a:sysClr");
  const color = colorOf(clr, theme) ?? "#000000";
  const alphaNode = clr ? findChild(childrenOf(clr), "a:alpha") : undefined;
  const alpha = alphaNode ? Number(attrOf(alphaNode, "val")) / 100000 : 0.4; // 기본 그림자 ~40%
  return `drop-shadow(${ox.toFixed(1)}px ${oy.toFixed(1)}px ${blurPx.toFixed(1)}px ${hexToRgba(color, alpha)})`;
}
/** a:ln → CSS border 단축값. noFill 면 undefined(테두리 없음). */
function lnCss(ln: XmlNode | undefined, theme: Record<string, string>): string | undefined {
  if (!ln) return undefined;
  const kids = childrenOf(ln);
  if (findChild(kids, "a:noFill")) return undefined;
  const w = Number(attrOf(ln, "w"));
  const wpx = Number.isFinite(w) && w > 0 ? Math.max(1, Math.round(w / EMU)) : 1;
  const color = colorFromFill(findChild(kids, "a:solidFill"), theme);
  const dash = attrOf(findChild(kids, "a:prstDash") ?? {}, "val") ?? "";
  const style = dash.includes("dash") ? "dashed" : dash.includes("dot") ? "dotted" : "solid";
  return `${wpx}px ${style} ${color ?? "#000000"}`;
}
/** p:style 의 a:fillRef/a:lnRef 색(테마 참조). idx=0 은 채우기/선 없음. */
function refColor(node: XmlNode, ref: string, theme: Record<string, string>): string | undefined {
  const style = findChild(childrenOf(node), "p:style");
  const r = style ? findChild(childrenOf(style), ref) : undefined;
  if (!r || attrOf(r, "idx") === "0") return undefined;
  const clr = findChild(childrenOf(r), "a:schemeClr") ?? findChild(childrenOf(r), "a:srgbClr") ?? findChild(childrenOf(r), "a:sysClr");
  return colorOf(clr, theme);
}
/** prstGeom 형상 → CSS 근사(타원·둥근모서리·삼각형·화살표·셰브론 등). avLst 미반영 근사치. */
function geomCss(prst: string | undefined): string | undefined {
  if (!prst) return undefined;
  const clip = (p: string) => `clip-path:polygon(${p})`;
  switch (prst) {
    case "ellipse": return "border-radius:50%";
    case "roundRect": case "round1Rect": case "round2SameRect": case "round2DiagRect":
    case "flowChartAlternateProcess": case "flowChartTerminator": return "border-radius:12px";
    case "triangle": return clip("50% 0,100% 100%,0 100%");
    case "rtTriangle": return clip("0 0,0 100%,100% 100%");
    case "diamond": case "flowChartDecision": return clip("50% 0,100% 50%,50% 100%,0 50%");
    case "pentagon": case "homePlate": return clip("0 0,75% 0,100% 50%,75% 100%,0 100%");
    case "chevron": return clip("0 0,75% 0,100% 50%,75% 100%,0 100%,25% 50%");
    case "hexagon": return clip("25% 0,75% 0,100% 50%,75% 100%,25% 100%,0 50%");
    case "rightArrow": case "notchedRightArrow": case "stripedRightArrow":
      return clip("0 30%,60% 30%,60% 0,100% 50%,60% 100%,60% 70%,0 70%");
    case "leftArrow":
      return clip("100% 30%,40% 30%,40% 0,0 50%,40% 100%,40% 70%,100% 70%");
    case "upArrow":
      return clip("30% 100%,30% 40%,0 40%,50% 0,100% 40%,70% 40%,70% 100%");
    case "downArrow":
      return clip("30% 0,30% 60%,0 60%,50% 100%,100% 60%,70% 60%,70% 0");
    case "leftRightArrow":
      return clip("0 50%,20% 20%,20% 35%,80% 35%,80% 20%,100% 50%,80% 80%,80% 65%,20% 65%,20% 80%");
    case "parallelogram": return clip("20% 0,100% 0,80% 100%,0 100%");
    case "trapezoid": return clip("20% 0,80% 0,100% 100%,0 100%");
    default: return undefined;
  }
}
/** 슬라이드/레이아웃/마스터의 p:bg → 배경 CSS 색(bgPr solidFill 또는 bgRef 테마색). */
function bgFromRoot(root: XmlNode[], theme: Record<string, string>): string | undefined {
  const bg = findDeep(root, "p:bg");
  if (!bg) return undefined;
  const bgPr = findChild(childrenOf(bg), "p:bgPr");
  if (bgPr) {
    const c = fillColorOf(bgPr, theme);
    if (c === "none") return undefined;
    if (c) return c;
  }
  const bgRef = findChild(childrenOf(bg), "p:bgRef");
  if (bgRef) {
    const clr = findChild(childrenOf(bgRef), "a:schemeClr") ?? findChild(childrenOf(bgRef), "a:srgbClr") ?? findChild(childrenOf(bgRef), "a:sysClr");
    return colorOf(clr, theme);
  }
  return undefined;
}
function bgFromPart(parts: Record<string, Uint8Array>, partPath: string | undefined, theme: Record<string, string>): string | undefined {
  const xml = partPath ? tryPartToText(parts, partPath) : undefined;
  return xml ? bgFromRoot(parseXml(xml), theme) : undefined;
}

// ── 그룹 변환(자식좌표계 → 슬라이드좌표계, 스케일+평행이동) ─────────────────────

interface XF { ax: number; bx: number; ay: number; by: number } // slide = a + local*b
const ROOT_XF: XF = { ax: 0, bx: 1, ay: 0, by: 1 };
function applyXF(xf: XF, b: Box): Box {
  return { x: xf.ax + b.x * xf.bx, y: xf.ay + b.y * xf.by, w: b.w * xf.bx, h: b.h * xf.by };
}
/** p:grpSp 의 grpSpPr xfrm(off/ext/chOff/chExt) 을 부모 XF 와 합성. */
function groupXF(parent: XF, node: XmlNode): XF {
  const gpr = findChild(childrenOf(node), "p:grpSpPr");
  const xfrm = gpr ? findChild(childrenOf(gpr), "a:xfrm") : undefined;
  if (!xfrm) return parent;
  const k = childrenOf(xfrm);
  const off = findChild(k, "a:off"), ext = findChild(k, "a:ext");
  const chOff = findChild(k, "a:chOff"), chExt = findChild(k, "a:chExt");
  if (!off || !ext || !chOff || !chExt) return parent;
  const ox = px(attrOf(off, "x")), oy = px(attrOf(off, "y"));
  const ew = px(attrOf(ext, "cx")), eh = px(attrOf(ext, "cy"));
  const cox = px(attrOf(chOff, "x")), coy = px(attrOf(chOff, "y"));
  const cew = px(attrOf(chExt, "cx")), ceh = px(attrOf(chExt, "cy"));
  if (cew <= 0 || ceh <= 0) return parent;
  const bx = (ew / cew) * parent.bx, by = (eh / ceh) * parent.by;
  return { ax: parent.ax + ox * parent.bx - cox * bx, bx, ay: parent.ay + oy * parent.by - coy * by, by };
}

// ── 연결선(cxnSp): 화살촉 달린 선 ────────────────────────────────────────────

/** 끝점(tx,ty)에서 (fx,fy) 방향 반대로 향하는 삼각형 화살촉 폴리곤 좌표. */
function arrowHead(tx: number, ty: number, fx: number, fy: number, size: number): string {
  const dx = tx - fx, dy = ty - fy;
  const L = Math.hypot(dx, dy) || 1;
  const ux = dx / L, uy = dy / L;          // 끝점 방향 단위벡터
  const bx = tx - ux * size, by = ty - uy * size; // 화살촉 밑변 중심
  const pxp = -uy, pyp = ux;               // 수직벡터
  const hw = size * 0.55;
  return `${tx.toFixed(1)},${ty.toFixed(1)} ${(bx + pxp * hw).toFixed(1)},${(by + pyp * hw).toFixed(1)} ${(bx - pxp * hw).toFixed(1)},${(by - pyp * hw).toFixed(1)}`;
}
const ARROW_ENDS = new Set(["triangle", "arrow", "stealth", "diamond"]);
/** p:cxnSp(straight/bent connector) → SVG 선 + 화살촉. box 는 슬라이드 절대좌표 px. */
function renderConnector(node: XmlNode, box: Box, theme: Record<string, string>): string {
  const spPr = findChild(childrenOf(node), "p:spPr");
  const xfrm = spPr ? findChild(childrenOf(spPr), "a:xfrm") : undefined;
  const flipH = !!xfrm && attrOf(xfrm, "flipH") === "1";
  const flipV = !!xfrm && attrOf(xfrm, "flipV") === "1";
  const ln = spPr ? findChild(childrenOf(spPr), "a:ln") : undefined;
  const lnKids = ln ? childrenOf(ln) : [];
  if (ln && findChild(lnKids, "a:noFill")) return "";
  const w = Number(attrOf(ln ?? {}, "w"));
  const sw = Number.isFinite(w) && w > 0 ? Math.max(1, w / EMU) : 1.5;
  const color = colorFromFill(findChild(lnKids, "a:solidFill"), theme) ?? refColor(node, "a:lnRef", theme) ?? "#595959";
  const dashVal = attrOf(findChild(lnKids, "a:prstDash") ?? {}, "val") ?? "";
  const dash = dashVal.includes("dash") ? ` stroke-dasharray="${sw * 3} ${sw * 2}"` : dashVal.includes("dot") ? ` stroke-dasharray="${sw} ${sw * 2}"` : "";
  const W = Math.max(box.w, 1), H = Math.max(box.h, 1);
  const x1 = flipH ? W : 0, y1 = flipV ? H : 0, x2 = flipH ? 0 : W, y2 = flipV ? 0 : H;
  const head = attrOf(findChild(lnKids, "a:headEnd") ?? {}, "type") ?? "none"; // 시작점(x1,y1)
  const tail = attrOf(findChild(lnKids, "a:tailEnd") ?? {}, "type") ?? "none"; // 끝점(x2,y2)
  const asz = Math.max(6, sw * 3);
  let marks = "";
  if (ARROW_ENDS.has(tail)) marks += `<polygon points="${arrowHead(x2, y2, x1, y1, asz)}" fill="${color}"/>`;
  if (ARROW_ENDS.has(head)) marks += `<polygon points="${arrowHead(x1, y1, x2, y2, asz)}" fill="${color}"/>`;
  const svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="position:absolute;left:0;top:0;overflow:visible">` +
    `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${sw}"${dash}/>${marks}</svg>`;
  const rot = rotOf(node);
  const rotCss = rot ? `transform:rotate(${rot}deg);` : "";
  const pos = `position:absolute;left:${box.x}px;top:${box.y}px;width:${box.w}px;height:${box.h}px;overflow:visible;${rotCss}`;
  return `<div class="pptx-cxn" style="${pos}">${svg}</div>`;
}

// ── 슬라이드 ───────────────────────────────────────────────────────────────────

interface SlideCtx {
  parts: Record<string, Uint8Array>;
  slidePath: string;
  rels: Rels;
  theme: Record<string, string>;
  layoutBox: Map<string, Box>;
  masterBox: Map<string, Box>;
  txStyles: TxStyles;
  layoutLst: Map<string, LvlStyles>;
  masterLst: Map<string, LvlStyles>;
  tableStyles: Map<string, TblStyle>;
}

function renderShape(node: XmlNode, ctx: SlideCtx, xf: XF = ROOT_XF): string {
  const tag = tagOf(node);
  if (tag === "p:grpSp") {
    const cxf = groupXF(xf, node);
    const inner = childrenOf(node).map((c) => renderShape(c, ctx, cxf)).join("");
    // 그룹 전체 회전: 자식은 슬라이드좌표에 평탄화돼 있으니, 그룹중심 기준으로 통째 회전하는
    // 래퍼(슬라이드 전체크기, origin=그룹중심)로 감싼다. 중첩그룹도 같은 좌표라 회전이 합성된다.
    const rot = rotOf(node);
    const gbox = rot ? groupBoxSlide(xf, node) : undefined;
    if (rot && gbox) {
      const cx = gbox.x + gbox.w / 2, cy = gbox.y + gbox.h / 2;
      return `<div style="position:absolute;left:0;top:0;width:100%;height:100%;transform-origin:${cx}px ${cy}px;transform:rotate(${rot}deg)">${inner}</div>`;
    }
    return inner;
  }
  const local = resolveBox(node, ctx.layoutBox, ctx.masterBox);
  const box = local ? applyXF(xf, local) : undefined;
  const pos = box ? `position:absolute;left:${box.x}px;top:${box.y}px;width:${box.w}px;height:${box.h}px;` : "position:relative;";
  // 연결선: 화살촉 달린 선(SVG). 텍스트가 붙은 cxnSp 는 드물어 박스로직 대신 선으로.
  if (tag === "p:cxnSp" && box) return renderConnector(node, box, ctx.theme);
  if (tag === "p:sp" || tag === "p:cxnSp") {
    const spPr = findChild(childrenOf(node), "p:spPr");
    const fill = fillColorOf(spPr, ctx.theme) ?? refColor(node, "a:fillRef", ctx.theme);
    const lnNode = spPr ? findChild(childrenOf(spPr), "a:ln") : undefined;
    let border = lnCss(lnNode, ctx.theme);
    if (border === undefined && !lnNode) { const lr = refColor(node, "a:lnRef", ctx.theme); if (lr) border = `1px solid ${lr}`; }
    const geom = spPr ? findChild(childrenOf(spPr), "a:prstGeom") : undefined;
    const shapeCss = geomCss(geom ? attrOf(geom, "prst") : undefined);

    const ph = phOf(node);
    const layers: LvlStyles[] = [ctx.txStyles[styleCategory(node)]];
    const mPh = phLayer(ctx.masterLst, ph); if (mPh) layers.push(mPh);
    const lPh = phLayer(ctx.layoutLst, ph); if (lPh) layers.push(lPh);
    const body = renderTextBody(node, layers, ctx.theme);

    const hasFill = !!fill && fill !== "none";
    if (!body && !hasFill && !border) return "";
    // 세로 정렬: a:bodyPr anchor(t/ctr/b)
    const bodyPr = findDeep([node], "a:bodyPr");
    const anchor = bodyPr ? attrOf(bodyPr, "anchor") : undefined;
    const justify = anchor === "ctr" ? "center" : anchor === "b" ? "flex-end" : "flex-start";
    const rot = rotOf(node);
    const shadow = shadowCss(node, ctx.theme);
    const d = [pos, "display:flex", "flex-direction:column", `justify-content:${justify}`];
    if (hasFill) d.push(`background:${fill}`);
    if (border) d.push(`border:${border}`);
    if (shapeCss) d.push(shapeCss);
    if (rot) d.push(`transform:rotate(${rot}deg)`);
    if (shadow) d.push(`filter:${shadow}`);
    return `<div class="pptx-sp" style="${d.join(";")}">${body}</div>`;
  }
  const rot = rotOf(node);
  const shadow = shadowCss(node, ctx.theme);
  const extra = (rot ? `transform:rotate(${rot}deg);` : "") + (shadow ? `filter:${shadow};` : "");
  if (tag === "p:pic") return `<div class="pptx-pic" style="${pos}${extra}">${renderPic(node, ctx.parts, ctx.slidePath, ctx.rels)}</div>`;
  if (tag === "p:graphicFrame") return `<div class="pptx-frame" style="${pos}${extra}">${renderTbl(node, ctx.theme, ctx.tableStyles, ctx.txStyles)}</div>`;
  return "";
}

export function pptxToPreviewHtml(bytes: Uint8Array, opts: PreviewOptions = {}): string {
  const parts = readZip(bytes);
  const pres = tryPartToText(parts, "ppt/presentation.xml");
  const sz = pres ? findDeep(parseXml(pres), "p:sldSz") : undefined;
  const W = sz ? px(attrOf(sz, "cx")) : 960;
  const H = sz ? px(attrOf(sz, "cy")) : 720;

  const slides = slidePaths(parts)
    .map((slidePath, i) => {
      const xml = tryPartToText(parts, slidePath);
      if (!xml) return "";
      const rels = readRels(parts, relsPathFor(slidePath));
      const layoutTarget = [...rels.values()].find((r) => r.type.includes("slideLayout"))?.target;
      const layoutPath = layoutTarget ? resolvePath(slidePath, layoutTarget) : undefined;
      const layoutRels: Rels = layoutPath ? readRels(parts, relsPathFor(layoutPath)) : new Map();
      const masterTarget = [...layoutRels.values()].find((r) => r.type.includes("slideMaster"))?.target;
      const masterPath = layoutPath && masterTarget ? resolvePath(layoutPath, masterTarget) : undefined;
      const theme = themePalette(parts, masterPath);

      const ctx: SlideCtx = {
        parts, slidePath, rels, theme,
        layoutBox: placeholderBoxes(parts, layoutPath),
        masterBox: placeholderBoxes(parts, masterPath),
        txStyles: masterTxStyles(parts, masterPath, theme),
        layoutLst: placeholderLstStyles(parts, layoutPath, theme),
        masterLst: placeholderLstStyles(parts, masterPath, theme),
        tableStyles: parseTableStyles(parts, theme),
      };
      const root = parseXml(xml);
      // 배경: 슬라이드 → 레이아웃 → 마스터 순으로 상속.
      const bg = bgFromRoot(root, theme) ?? bgFromPart(parts, layoutPath, theme) ?? bgFromPart(parts, masterPath, theme);
      const bgCss = bg ? `;background:${bg}` : "";
      const spTree = findDeep(root, "p:spTree");
      const shapes = spTree ? childrenOf(spTree).map((n) => renderShape(n, ctx)).join("") : "";
      // 슬라이드는 고정 px 캔버스에 도형을 절대배치한다. 컨테이너가 좁으면 stage(반응형 너비)
      // 안에서 transform:scale 로 통째로 축소해 잘리지 않게 한다(스크립트가 채움).
      return `<div class="pptx-slide-no">슬라이드 ${i + 1}</div>` +
        `<div class="pptx-stage"><div class="pptx-slide" data-w="${W}" data-h="${H}" style="width:${W}px;height:${H}px${bgCss}">${shapes}</div></div>`;
    })
    .join("\n");

  const css = `
  body { padding: 18px; background:#eceef0; }
  .pptx-slide-no { font-size:11px; color:#9aa0a6; margin:0 auto 6px; width:100%; }
  /* stage = 가용 폭을 가득 채움(원본보다 크면 확대, 작으면 축소). 좌우 회색여백을 없앤다.
     높이는 스크립트가 스케일에 맞춰 채운다. */
  .pptx-stage { position:relative; margin:0 auto 26px; width:100%; }
  .pptx-slide { position:relative; background:#fff; overflow:hidden; transform-origin:top left;
    box-shadow:0 1px 4px rgba(0,0,0,.12),0 8px 24px rgba(0,0,0,.10); }
  .pptx-sp { overflow:hidden; line-height:1.25; box-sizing:border-box; }
  .pptx-sp p { margin:0; }
  .pptx-bul { margin-right:.4em; }
  .pptx-pic { overflow:hidden; }
  .pptx-ph-img { width:100%; height:100%; display:grid; place-items:center; text-align:center; color:#9aa0a6; background:#f3f4f6; font-size:13px; }
  .pptx-frame { overflow:visible; }
  .pptx-tbl { border-collapse:collapse; width:100%; table-layout:fixed; font-size:12px; }
  .pptx-tbl td { border:1px solid #c9ccd1; padding:3px 6px; vertical-align:top; color:#1a1a1a;
    word-break:break-word; overflow-wrap:anywhere; white-space:normal; }
  .pptx-tbl p { margin:0; }
  `;
  // 컨테이너 너비에 맞춰 각 슬라이드를 비율유지 축소(절대배치라 CSS 만으론 안 줄어듦).
  const scaler = `<script>(function(){
  function fit(){
    var st=document.querySelectorAll('.pptx-stage');
    for(var i=0;i<st.length;i++){
      var s=st[i], slide=s.firstElementChild; if(!slide)continue;
      var W=parseFloat(slide.getAttribute('data-w'))||1, H=parseFloat(slide.getAttribute('data-h'))||1;
      var avail=s.clientWidth; if(!avail)continue;
      var k=Math.min(avail/W, 3); // 가용 폭을 채움(확대/축소), 과확대만 방지
      slide.style.transform='scale('+k+')';
      s.style.height=(H*k)+'px';
    }
  }
  fit(); window.addEventListener('resize',fit);
})();</script>`;
  return toPreviewHtml(`<div class="pptx-wrap">${slides}</div>${scaler}`, { ...opts, css: (opts.css ?? "") + css });
}

export const pptxAdapter: FormatAdapter = {
  id: "pptx",
  label: "PowerPoint 프레젠테이션 (.pptx)",
  supportsRoundTrip: true,
  detect(parts) {
    return Object.keys(parts).some((p) => p.startsWith("ppt/"));
  },
  encode(bytes) {
    return encodePptxToHtml(bytes);
  },
  decode(html, manifest) {
    return decodeHtmlToPptx(html, manifest);
  },
  toPreviewHtml(bytes, opts) {
    return pptxToPreviewHtml(bytes, (opts ?? {}) as PreviewOptions);
  },
};

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
