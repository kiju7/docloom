/**
 * .ppt(PowerPoint 97-2003 바이너리) 리치 미리보기 — OfficeArt 드로잉을 절대배치로 렌더.
 *
 * pptx 와 달리 XML 이 아니라 MS-PPT/MS-ODRAW 의 중첩 바이너리 레코드다. 여기서 추출:
 *   - DocumentAtom(0x03E9) slideSize → 캔버스(px = master units / 6, 576u=1inch=96px).
 *   - 각 Slide(0x03EE) → Drawing(0x040C) → OfficeArt 도형트리.
 *   - 도형(0xF004): FSP(0xF00A) flags, ClientAnchor(0xF010, int16 top/left/right/bottom)
 *     또는 그룹내 ChildAnchor(0xF011, int32 left/top/right/bottom), FOPT(0xF00B) 속성
 *     (fillColor 0x0181·lineColor 0x01C0·pib 0x0104 이미지), ClientTextbox 텍스트.
 *   - 그룹(0xF003): FSPGR(0xF009) 자식좌표계 → 자식 ChildAnchor 를 슬라이드좌표로 변환.
 *   - 이미지: pib → 문서 BStore(FBSE 0xF007) foDelay → "Pictures" 스트림 BLIP → data URI.
 *   - 색: COLORREF(RGB) 또는 scheme-index → ColorSchemeAtom(0x07F0) 8색 팔레트.
 *
 * 한계: 텍스트 서식은 StyleTextPropAtom 의 글자크기/색만 best-effort(없으면 txType 기본).
 *   회전·그라데이션·도형 효과·정확한 자동맞춤은 근사/미반영.
 */
import { readCfb } from "../core/cfb.js";
import { toPreviewHtml, type PreviewOptions } from "../preview/preview.js";
import { bytesToBase64 } from "../core/base64.js";

// ── 레코드 워커 ────────────────────────────────────────────────────────────────
interface Rec { type: number; inst: number; container: boolean; bs: number; be: number }
function records(dv: DataView, start: number, end: number): Rec[] {
  const out: Rec[] = [];
  let p = start;
  while (p + 8 <= end) {
    const vi = dv.getUint16(p, true);
    const type = dv.getUint16(p + 2, true);
    const len = dv.getUint32(p + 4, true);
    const bs = p + 8, be = bs + len;
    if (be > end) break;
    out.push({ type, inst: vi >> 4, container: (vi & 0x0f) === 0x0f, bs, be });
    p = be;
  }
  return out;
}
function findRec(dv: DataView, start: number, end: number, type: number, deep = false): Rec | undefined {
  for (const r of records(dv, start, end)) {
    if (r.type === type) return r;
    if (deep && r.container) { const f = findRec(dv, r.bs, r.be, type, true); if (f) return f; }
  }
  return undefined;
}

// ── 색 ────────────────────────────────────────────────────────────────────────
function colorRef(value: number, scheme: string[]): string | undefined {
  const flags = (value >>> 24) & 0xff;
  if (flags & 0x08) { // fSchemeIndex: 하위바이트 = 8색 팔레트 인덱스
    const idx = value & 0xff;
    return scheme[idx];
  }
  const r = value & 0xff, g = (value >> 8) & 0xff, b = (value >> 16) & 0xff;
  return "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase();
}
/** ColorSchemeAtom(0x07F0): 8 × COLORREF. */
function readScheme(dv: DataView, bs: number, be: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < 8 && bs + i * 4 + 4 <= be; i++) {
    const v = dv.getUint32(bs + i * 4, true);
    const r = v & 0xff, g = (v >> 8) & 0xff, b = (v >> 16) & 0xff;
    out.push("#" + [r, g, b].map((x) => x.toString(16).padStart(2, "0")).join("").toUpperCase());
  }
  return out;
}
const DEFAULT_SCHEME = ["#FFFFFF", "#000000", "#808080", "#000000", "#BBE0E3", "#333399", "#009999", "#99CC00"];

// ── FOPT(도형 속성 테이블) ───────────────────────────────────────────────────
interface ShapeOpts { fillColor?: number; fFilled?: boolean; lineColor?: number; fLine?: boolean; pib?: number; anchor?: number }
function readFOPT(dv: DataView, r: Rec): ShapeOpts {
  const o: ShapeOpts = {};
  const n = r.inst; // 속성 개수
  let p = r.bs;
  for (let i = 0; i < n && p + 6 <= r.be; i++) {
    const opid = dv.getUint16(p, true);
    const val = dv.getUint32(p + 2, true);
    const prop = opid & 0x3fff;
    p += 6;
    if (prop === 0x0104) o.pib = val;                 // pib: BLIP 인덱스(1-based)
    else if (prop === 0x0181) o.fillColor = val;      // fillColor
    else if (prop === 0x01c0) o.lineColor = val;      // lineColor
    else if (prop === 0x01bf) o.fFilled = !!(val & 0x10); // fillStyleBooleans: fFilled
    else if (prop === 0x01ff) o.fLine = !!(val & 0x08);   // lineStyleBooleans: fLine
    else if (prop === 0x0087) o.anchor = val;         // anchorText(0=top,1=mid,2=bot,3=topCtr,4=midCtr,5=botCtr)
  }
  return o;
}

// ── 이미지(BStore + Pictures) ──────────────────────────────────────────────────
const PIC_MAGIC: [number[], string][] = [
  [[0x89, 0x50, 0x4e, 0x47], "image/png"],
  [[0xff, 0xd8, 0xff], "image/jpeg"],
  [[0x47, 0x49, 0x46], "image/gif"],
  [[0x42, 0x4d], "image/bmp"],
];
/** FBSE 들의 foDelay(=Pictures 오프셋) 배열. pib(1-based) → foDelay. */
function readBlipStore(dv: DataView, docEnd: number): number[] {
  // DocumentContainer → PPDrawingGroup(0x040B) → OfficeArtDgg(0xF000) → BStore(0xF001) → FBSE(0xF007)
  const dgg = findRec(dv, 0, docEnd, 0xf000, true);
  if (!dgg) return [];
  const store = findRec(dv, dgg.bs, dgg.be, 0xf001, true);
  if (!store) return [];
  const offs: number[] = [];
  for (const fbse of records(dv, store.bs, store.be)) {
    if (fbse.type !== 0xf007) continue;
    // FBSE: btWin32(1)+btMac(1)+rgbUid(16)+tag(2)+size(4)+cRef(4)+foDelay(4)…
    const foDelay = dv.getUint32(fbse.bs + 2 + 16 + 2 + 4 + 4, true);
    offs.push(foDelay);
  }
  return offs;
}
/** Pictures 스트림의 foDelay 위치 BLIP → data URI(헤더 후 이미지 매직 탐색). */
function blipDataUri(pics: Uint8Array, foDelay: number): string | undefined {
  if (foDelay + 8 > pics.length) return undefined;
  const dv = new DataView(pics.buffer, pics.byteOffset, pics.byteLength);
  const len = dv.getUint32(foDelay + 4, true);
  const dataStart = foDelay + 8, dataEnd = Math.min(pics.length, dataStart + len);
  // 헤더 뒤 ~60B 안에서 래스터 매직을 찾아 거기부터 슬라이스(UID 개수 모호성 회피).
  for (let s = dataStart; s < Math.min(dataStart + 80, dataEnd - 3); s++) {
    for (const [magic, mime] of PIC_MAGIC) {
      if (magic.every((m, k) => pics[s + k] === m)) {
        return `data:${mime};base64,${bytesToBase64(pics.subarray(s, dataEnd))}`;
      }
    }
  }
  return undefined;
}

// ── 텍스트 ──────────────────────────────────────────────────────────────────────
function esc(s: string): string { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
/** ClientTextbox(0xF00D) → 문단 HTML(글자크기/색은 StyleTextProp best-effort). */
function readText(dv: DataView, buf: Uint8Array, tb: Rec): { html: string; txType: number; base: number } | undefined {
  let raw: string | undefined;
  let txType = -1;
  const th = findRec(dv, tb.bs, tb.be, 0x0f9f); // TextHeaderAtom
  if (th && th.be - th.bs >= 4) txType = dv.getUint32(th.bs, true);
  const tc = findRec(dv, tb.bs, tb.be, 0x0fa0); // TextCharsAtom (UTF-16LE)
  if (tc) { let s = ""; for (let q = tc.bs; q + 1 < tc.be; q += 2) s += String.fromCharCode(dv.getUint16(q, true)); raw = s; }
  else {
    const tbs = findRec(dv, tb.bs, tb.be, 0x0fa8); // TextBytesAtom (Latin1)
    if (tbs) { let s = ""; for (let q = tbs.bs; q < tbs.be; q++) s += String.fromCharCode(buf[q]!); raw = s; }
  }
  if (raw == null) return undefined;
  // 글자크기: StyleTextProp 의 문단/문자 예외 필드테이블이 복잡해 신뢰 불가(어긋나면 깨짐).
  // txType(자리표시자 종류)별 기본 크기로 안정 렌더. (서식 정밀도는 범위 밖)
  const base = txType === 0 || txType === 6 ? 30 : txType === 2 ? 13 : 17; // 제목/노트/본문
  // 0x0D=문단끝, 0x0B=줄바꿈.
  const paras = raw.replace(/\x00/g, "").split("\r");
  let html = "";
  for (const para of paras) {
    const txt = para.replace(/\x0b/g, "\n");
    const lines = esc(txt).split("\n").join("<br/>");
    html += txt.trim() ? `<p>${lines}</p>` : `<p>&#8203;</p>`;
  }
  return { html, txType, base };
}
// ── 도형 트리 ────────────────────────────────────────────────────────────────
interface Box { x: number; y: number; w: number; h: number }
interface XF { ax: number; bx: number; ay: number; by: number }
const ID: XF = { ax: 0, bx: 1, ay: 0, by: 1 };
const U = 6; // master units per px (576/96)

function renderSp(dv: DataView, buf: Buf, sp: Rec, xf: XF, ctx: Ctx): string {
  const kids = records(dv, sp.bs, sp.be);
  const fsp = kids.find((k) => k.type === 0xf00a);
  const flags = fsp ? dv.getUint32(fsp.bs + 4, true) : 0;
  const isGroup = !!(flags & 0x0001);
  if (isGroup) return ""; // 그룹 자체는 컨테이너에서 처리

  const optRec = kids.find((k) => k.type === 0xf00b);
  const opt = optRec ? readFOPT(dv, optRec) : {};
  // 앵커 → 슬라이드좌표 px. ClientAnchor(0xF010, int16)는 **슬라이드 절대좌표**(그룹 안이라도
  // identity). ChildAnchor(0xF011, 정확히 16B int32)만 그룹 child-space → 그룹 XF 적용.
  // (66B 등 비표준 0xF011 은 클라이언트데이터(___PPT9) 오인이므로 무시.)
  let box: Box | undefined;
  const ca = kids.find((k) => k.type === 0xf010 && k.be - k.bs >= 8);
  const cha = kids.find((k) => k.type === 0xf00f && k.be - k.bs === 16);
  if (ca) {
    const top = dv.getInt16(ca.bs, true), left = dv.getInt16(ca.bs + 2, true);
    const right = dv.getInt16(ca.bs + 4, true), bottom = dv.getInt16(ca.bs + 6, true);
    box = mapBox({ x: left, y: top, w: right - left, h: bottom - top }, ID);
  } else if (cha) {
    const left = dv.getInt32(cha.bs, true), top = dv.getInt32(cha.bs + 4, true);
    const right = dv.getInt32(cha.bs + 8, true), bottom = dv.getInt32(cha.bs + 12, true);
    box = mapBox({ x: left, y: top, w: right - left, h: bottom - top }, xf);
  }
  if (!box || box.w <= 0 || box.h <= 0) return "";

  // 좌표는 master units 로 계산됨 → emit 시 /U 로 px.
  const X = box.x / U, Y = box.y / U, Wd = box.w / U, Ht = box.h / U;
  const pos = `position:absolute;left:${X.toFixed(1)}px;top:${Y.toFixed(1)}px;width:${Wd.toFixed(1)}px;height:${Ht.toFixed(1)}px`;

  // 이미지.
  if (opt.pib && ctx.blipOffsets[opt.pib - 1] != null) {
    const uri = blipDataUri(ctx.pics, ctx.blipOffsets[opt.pib - 1]!);
    if (uri) return `<div class="ppt-pic" style="${pos}"><img src="${uri}" style="width:100%;height:100%;object-fit:contain" alt=""/></div>`;
  }

  // 채우기/윤곽선.
  const d = [pos];
  if (opt.fFilled !== false && opt.fillColor != null) {
    const c = colorRef(opt.fillColor, ctx.scheme);
    if (c) d.push(`background:${c}`);
  }
  if (opt.fLine && opt.lineColor != null) {
    const c = colorRef(opt.lineColor, ctx.scheme);
    if (c) d.push(`border:1px solid ${c}`);
  }

  // 텍스트.
  const tb = kids.find((k) => k.type === 0xf00d);
  const txt = tb ? readText(dv, buf, tb) : undefined;
  const hasFill = d.length > 1;
  if (!txt && !hasFill) return "";
  d.push("display:flex", "flex-direction:column", "justify-content:center", "overflow:hidden");
  if (txt) {
    d.push(`font-size:${txt.base}pt`);
    if (txt.txType === 5 || txt.txType === 6) d.push("text-align:center"); // 가운데 제목/본문
  }
  return `<div class="ppt-sp" style="${d.join(";")}">${txt?.html ?? ""}</div>`;
}

function renderGroup(dv: DataView, buf: Buf, grp: Rec, xf: XF, ctx: Ctx): string {
  // 첫 자식 spContainer = 그룹 자신(FSPGR 자식좌표계 + ClientAnchor 슬라이드위치).
  const children = records(dv, grp.bs, grp.be);
  const head = children.find((k) => k.type === 0xf004);
  let cxf = xf;
  if (head) {
    const hk = records(dv, head.bs, head.be);
    const fspgr = hk.find((k) => k.type === 0xf009);
    const ca = hk.find((k) => k.type === 0xf010 && k.be - k.bs >= 8);
    const cha = hk.find((k) => k.type === 0xf00f && k.be - k.bs === 16);
    if (fspgr && fspgr.be - fspgr.bs >= 16) {
      const cl = dv.getInt32(fspgr.bs, true), ct = dv.getInt32(fspgr.bs + 4, true);
      const cr = dv.getInt32(fspgr.bs + 8, true), cb = dv.getInt32(fspgr.bs + 12, true);
      let outer: Box | undefined;
      if (ca && ca.be - ca.bs >= 8) {
        const t = dv.getInt16(ca.bs, true), l = dv.getInt16(ca.bs + 2, true), r = dv.getInt16(ca.bs + 4, true), b = dv.getInt16(ca.bs + 6, true);
        outer = mapBox({ x: l, y: t, w: r - l, h: b - t }, xf);
      } else if (cha && cha.be - cha.bs >= 16) {
        const l = dv.getInt32(cha.bs, true), t = dv.getInt32(cha.bs + 4, true), r = dv.getInt32(cha.bs + 8, true), b = dv.getInt32(cha.bs + 12, true);
        outer = mapBox({ x: l, y: t, w: r - l, h: b - t }, xf);
      }
      const cw = cr - cl || 1, chh = cb - ct || 1;
      if (outer) {
        const bx = outer.w / cw, by = outer.h / chh;
        cxf = { ax: outer.x - cl * bx, bx, ay: outer.y - ct * by, by };
      }
    }
  }
  let out = "";
  for (const c of children) {
    if (c === head) continue;
    if (c.type === 0xf004) out += renderSp(dv, buf, c, cxf, ctx);
    else if (c.type === 0xf003) out += renderGroup(dv, buf, c, cxf, ctx);
  }
  return out;
}

/** 앵커 → 변환된 좌표(master units, /U 는 emit 시점). */
function mapBox(b: Box, xf: XF): Box {
  return { x: xf.ax + b.x * xf.bx, y: xf.ay + b.y * xf.by, w: b.w * xf.bx, h: b.h * xf.by };
}

type Buf = Uint8Array;
interface Ctx { pics: Uint8Array; blipOffsets: number[]; scheme: string[] }

// ── 슬라이드 ────────────────────────────────────────────────────────────────────
function renderSlide(dv: DataView, buf: Buf, slide: Rec, ctx: Ctx): string {
  // 슬라이드 색구성표(있으면 갱신).
  const cs = findRec(dv, slide.bs, slide.be, 0x07f0, true);
  const scheme = cs ? readScheme(dv, cs.bs, cs.be) : ctx.scheme;
  const sctx = { ...ctx, scheme };
  const drawing = findRec(dv, slide.bs, slide.be, 0x040c); // PPDrawing
  if (!drawing) return "";
  const dg = findRec(dv, drawing.bs, drawing.be, 0xf002); // DgContainer
  if (!dg) return "";
  const spgr = findRec(dv, dg.bs, dg.be, 0xf003); // 최상위 그룹
  if (!spgr) return "";
  let out = "";
  // 최상위 spgr 의 자식들(첫 자식=패트리아크 그룹쉐이프, 건너뜀).
  const kids = records(dv, spgr.bs, spgr.be);
  for (let i = 0; i < kids.length; i++) {
    const c = kids[i]!;
    if (i === 0 && c.type === 0xf004) continue; // patriarch
    if (c.type === 0xf004) out += renderSp(dv, buf, c, ID, sctx);
    else if (c.type === 0xf003) out += renderGroup(dv, buf, c, ID, sctx);
  }
  return out;
}

export function pptToRichHtml(bytes: Uint8Array, opts: PreviewOptions = {}): string {
  const cfb = readCfb(bytes);
  const buf = cfb.streams["PowerPoint Document"];
  if (!buf) throw new Error("no PowerPoint Document stream");
  const pics = cfb.streams["Pictures"] ?? new Uint8Array(0);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  // slideSize.
  const da = findRec(dv, 0, buf.length, 0x03e9, true);
  let W = 1280, H = 720;
  if (da && da.be - da.bs >= 8) { W = Math.round(dv.getInt32(da.bs, true) / U); H = Math.round(dv.getInt32(da.bs + 4, true) / U); }
  if (!(W > 0 && H > 0)) { W = 1280; H = 720; }

  const blipOffsets = readBlipStore(dv, buf.length);
  // 문서 기본 색구성표.
  const cs0 = findRec(dv, 0, buf.length, 0x07f0, true);
  const scheme = cs0 ? readScheme(dv, cs0.bs, cs0.be) : DEFAULT_SCHEME;
  const ctx: Ctx = { pics, blipOffsets, scheme };

  // 슬라이드 순서 = 문서 내 Slide(0x03EE) 등장 순서.
  const slides: Rec[] = [];
  const collect = (s: number, e: number): void => {
    for (const r of records(dv, s, e)) {
      if (r.type === 0x03ee) slides.push(r);
      else if (r.container) collect(r.bs, r.be);
    }
  };
  collect(0, buf.length);

  let total = 0;
  const body = slides
    .map((sl, i) => {
      const shapes = renderSlide(dv, buf, sl, ctx);
      total += (shapes.match(/<div class="ppt-(sp|pic)"/g) ?? []).length;
      return `<div class="ppt-slide-no">슬라이드 ${i + 1}</div>` +
        `<div class="ppt-stage"><div class="ppt-slide" data-w="${W}" data-h="${H}" style="width:${W}px;height:${H}px">${shapes}</div></div>`;
    })
    .join("\n");
  // OfficeArt 드로잉에서 아무 도형도 못 뽑았으면(예: 합성 스트림·비표준) 텍스트 폴백으로.
  if (total === 0) throw new Error("no shapes extracted");

  const css = `
  body { padding: 18px; background:#eceef0; }
  .ppt-slide-no { font-size:11px; color:#9aa0a6; margin:0 auto 6px; width:100%; }
  .ppt-stage { position:relative; margin:0 auto 26px; width:100%; }
  .ppt-slide { position:relative; background:#fff; overflow:hidden; transform-origin:top left;
    box-shadow:0 1px 4px rgba(0,0,0,.12),0 8px 24px rgba(0,0,0,.10); }
  .ppt-sp { line-height:1.2; box-sizing:border-box; padding:2px 4px; color:#1a1a1a; font-size:14px; }
  .ppt-sp p { margin:0; }
  .ppt-pic { overflow:hidden; }
  `;
  const scaler = `<script>(function(){function fit(){var st=document.querySelectorAll('.ppt-stage');for(var i=0;i<st.length;i++){var s=st[i],sl=s.firstElementChild;if(!sl)continue;var W=parseFloat(sl.getAttribute('data-w'))||1,H=parseFloat(sl.getAttribute('data-h'))||1;var a=s.clientWidth;if(!a)continue;var k=Math.min(a/W,3);sl.style.transform='scale('+k+')';s.style.height=(H*k)+'px';}}fit();window.addEventListener('resize',fit);})();</script>`;
  if (!slides.length) throw new Error("no slides");
  return toPreviewHtml(`<div class="ppt-wrap">${body}</div>${scaler}`, { ...opts, css: (opts.css ?? "") + css });
}
