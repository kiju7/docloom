/**
 * pdf 포맷 어댑터 — T2(위치보존) 미리보기 전용. 왕복(encode/decode)은 미구현.
 *
 * PDF 는 의미구조(문단/런)가 없는 고정 레이아웃 페이지 기술 언어라, docloom 의
 * "원본 part 보존 + 콘텐츠 재생성" 왕복 철학이 성립하지 않는다(→ supportsRoundTrip:false).
 * 대신 콘텐츠 스트림의 텍스트 연산자를 해석해 **글자 묶음을 원래 좌표에 절대배치**하고,
 * 이미지 XObject 는 **배치 행렬(CTM)로 절대좌표 <img>** 를 깐다(아래 "이미지 조각" 참고).
 * 폰트 글꼴까지 픽셀완벽으로 재현하진 않지만(그건 래스터화 영역), 페이지·줄·단어·이미지
 * 위치는 보존한다.
 *
 * 이미지 조각(중요): 스캐너·편집기는 한 장의 그림을 여러 작은 이미지(타일/가로 스트립)로
 * 쪼개 인접 배치하는 일이 잦다. 각 조각을 **자기 CTM 으로 계산한 CSS matrix** 로 깔면 모든
 * 조각이 같은 좌표계에서 나와 이음매 없이 재조립된다(축정렬·회전·뒤집힘·전단 모두 일반 처리).
 *
 * 한계: 스캔 PDF 라도 이제 페이지 이미지가 보인다. JPEG=브라우저 디코드, Flate/raw=PNG 인코드.
 * JPX/CCITT/JBIG2 이미지와 벡터 그래픽은 미렌더(자리만). 암호화(AES)는 미지원 안내.
 */
import type { FormatAdapter } from "../core/format.js";
import { notImplemented } from "../core/format.js";
import { toPreviewHtml, type PreviewOptions } from "../preview/preview.js";
import { PdfDocument, PStream, type PDict, type PdfValue } from "../core/pdf/pdfObjects.js";
import { extractPageText, type PageText, type ImagePlacement, type RenderPath } from "../core/pdf/pdfText.js";
import { buildImage, type PdfImage } from "../core/pdf/pdfImages.js";
import { buildPdf } from "../core/pdf/pdfWriter.js";

/** 페이지당 이미지 상한(병적 문서 방어). */
const MAX_IMAGES_PER_PAGE = 2000;

/** PDF point(1/72in) → CSS px(1/96in). */
const PT2PX = 96 / 72;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 페이지의 /Contents(단일 또는 배열) 스트림을 디코드·연결. */
function pageContent(doc: PdfDocument, page: PDict): Uint8Array {
  const c = doc.get(page, "Contents");
  const streams: PStream[] = [];
  if (c instanceof PStream) streams.push(c);
  else if (Array.isArray(c)) for (const el of c) {
    const r = doc.resolve(el);
    if (r instanceof PStream) streams.push(r);
  }
  if (streams.length === 0) return new Uint8Array(0);
  const parts = streams.map((s) => doc.decodeStream(s));
  const total = parts.reduce((n, p) => n + p.length + 1, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
    out[off++] = 0x0a; // 스트림 사이 줄바꿈(연산자 경계 보호)
  }
  return out;
}

/** 페이지의 MediaBox/Rotate → 기하. */
function pageGeom(doc: PdfDocument, page: PDict): { x0: number; y0: number; wPt: number; hPt: number; rotate: number } {
  const mb = doc.resolve(doc.get(page, "MediaBox"));
  let x0 = 0, y0 = 0, x1 = 612, y1 = 792; // 기본 Letter
  if (Array.isArray(mb) && mb.length === 4) {
    const n = (v: PdfValue) => doc.numOf(v, 0);
    x0 = n(mb[0]!); y0 = n(mb[1]!); x1 = n(mb[2]!); y1 = n(mb[3]!);
  }
  let rotate = doc.numOf(doc.get(page, "Rotate"), 0);
  rotate = ((rotate % 360) + 360) % 360;
  return { x0, y0, wPt: Math.abs(x1 - x0), hPt: Math.abs(y1 - y0), rotate };
}

/**
 * 한 이미지 배치 → 절대좌표 <img>.
 * 이미지 단위정사각형 [0,1]²(좌하 원점, y 위쪽)을 CTM 으로 장치공간에 보낸 뒤, CSS 좌상단
 * 좌표계(y 아래쪽)로 환산한 변환행렬을 만든다. img 의 레이아웃 박스는 원본 픽셀크기(W×H)이고
 * transform 이 그걸 장치크기로 매핑하므로, 인접 조각이 같은 좌표계에서 정확히 맞물린다.
 */
function renderImage(img: PdfImage, ctm: number[], x0: number, y0: number, hPt: number): string {
  const [a, b, c, d, e, f] = ctm;
  const W = img.w, H = img.h;
  const s = PT2PX;
  // 로컬 픽셀(x∈[0,W], y∈[0,H], y 아래쪽) → CSS px. (u=x/W, v=1-y/H 대입 후 정리)
  const A = (s * a!) / W;
  const B = (-s * b!) / W;
  const C = (-s * c!) / H;
  const D = (s * d!) / H;
  const E = s * (c! + e! - x0);
  const F = s * (hPt + y0 - d! - f!);
  const t = (n: number) => (Number.isFinite(n) ? n.toFixed(4) : "0");
  return (
    `<img class="pdf-img" src="${img.uri}" width="${W}" height="${H}" alt="" ` +
    `style="transform:matrix(${t(A)},${t(B)},${t(C)},${t(D)},${t(E)},${t(F)})">`
  );
}

/** CTM 으로 변환한 단위정사각형의 축정렬 경계상자(px). 미지원 이미지 자리표시용. */
function placeholderBox(ctm: number[], x0: number, y0: number, hPt: number): { left: number; top: number; w: number; h: number } {
  const [a, b, c, d, e, f] = ctm as [number, number, number, number, number, number];
  const xs = [e, a + e, a + c + e, c + e];
  const ys = [f, b + f, b + d + f, d + f];
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const s = PT2PX;
  return { left: (minX - x0) * s, top: (hPt - (maxY - y0)) * s, w: (maxX - minX) * s, h: (maxY - minY) * s };
}

/** 미지원 이미지 라벨(형식·크기). */
function imageLabel(doc: PdfDocument, st: PStream): string {
  const f = doc.resolve(doc.get(st.dict, "Filter"));
  let name = "이미지";
  const pick = (v: PdfValue): string => (v && typeof v === "object" && "name" in (v as object) ? (v as { name: string }).name : "");
  if (Array.isArray(f) && f.length) name = pick(doc.resolve(f[f.length - 1]!)) || name;
  else name = pick(f) || name;
  const w = doc.numOf(doc.get(st.dict, "Width"), 0);
  const h = doc.numOf(doc.get(st.dict, "Height"), 0);
  return `🖼 ${esc(name)} ${w}×${h} (미지원)`;
}

/** 벡터 경로들 → 페이지를 덮는 SVG(표 테두리·배경칠·선·도형). */
function renderVectors(paths: RenderPath[], x0: number, y0: number, wPt: number, hPt: number): string {
  if (paths.length === 0) return "";
  const wPx = wPt * PT2PX, hPx = hPt * PT2PX;
  const s = PT2PX;
  const cx = (x: number) => ((x - x0) * s).toFixed(2);
  const cy = (y: number) => ((hPt - (y - y0)) * s).toFixed(2); // PDF y-up → CSS y-down
  const rgb = (c: [number, number, number]) => `rgb(${c[0]},${c[1]},${c[2]})`;
  let els = "";
  for (const p of paths) {
    let d = "";
    for (const cm of p.cmds) {
      if (cm.t === "M") d += `M${cx(cm.c[0]!)} ${cy(cm.c[1]!)}`;
      else if (cm.t === "L") d += `L${cx(cm.c[0]!)} ${cy(cm.c[1]!)}`;
      else if (cm.t === "C") d += `C${cx(cm.c[0]!)} ${cy(cm.c[1]!)} ${cx(cm.c[2]!)} ${cy(cm.c[3]!)} ${cx(cm.c[4]!)} ${cy(cm.c[5]!)}`;
      else d += "Z";
    }
    if (!d) continue;
    const fill = p.fill ? rgb(p.fill) : "none";
    const stroke = p.stroke ? rgb(p.stroke) : "none";
    const sw = p.stroke ? Math.max(p.lineWidth * s, 0.5).toFixed(2) : "0";
    const fr = p.evenOdd ? ` fill-rule="evenodd"` : "";
    els += `<path d="${d}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"${fr}/>`;
  }
  return `<svg class="pdf-vec" width="${wPx}" height="${hPx}" viewBox="0 0 ${wPx} ${hPx}">${els}</svg>`;
}

/** 한 텍스트 글리프 → 절대배치 span(굵기/기울임 반영). editable 면 data-pi/ii + contenteditable. */
function renderGlyph(it: PageText["items"][number], x0: number, y0: number, hPt: number, ed?: { pi: number; ii: number }): string {
  const left = (it.x - x0) * PT2PX;
  const sizePx = it.size * PT2PX;
  // PDF 원점은 좌하단·y 위쪽 → CSS 좌상단. 원점 y 는 글자 베이스라인이므로 상승분만큼 올려 배치.
  const top = (hPt - (it.y - y0)) * PT2PX - sizePx * 0.82;
  const w = it.bold ? "font-weight:700;" : "";
  const st = it.italic ? "font-style:italic;" : "";
  const editAttr = ed ? ` contenteditable="true" data-pi="${ed.pi}" data-ii="${ed.ii}"` : "";
  return (
    `<span class="pdf-t${ed ? " pdf-edit" : ""}"${editAttr} style="left:${left.toFixed(2)}px;top:${top.toFixed(2)}px;` +
    `font-size:${sizePx.toFixed(2)}px;${w}${st}">${esc(it.text)}</span>`
  );
}

/**
 * 한 페이지 → 이미지·벡터·텍스트를 **그린 순서(seq)대로** 합쳐 DOM 순서=페인트 순서로 렌더.
 * (전체페이지 흰 배경칠이 이미지보다 먼저 그려지면 뒤로 가도록 — 고정 3층 방식의 가림 버그 해결.)
 */
function renderPage(
  doc: PdfDocument,
  pt: PageText,
  index: number,
  imgCache: Map<PStream, PdfImage | null>,
  editable = false,
): string {
  const x0 = pt.x0, y0 = pt.y0;
  const wPx = pt.wPt * PT2PX;
  const hPx = pt.hPt * PT2PX;

  // 그리기 이벤트를 seq 로 병합 정렬.
  type Ev = { seq: number; kind: 0 | 1 | 2; i: number };
  const evs: Ev[] = [];
  for (let i = 0; i < pt.paths.length; i++) evs.push({ seq: pt.paths[i]!.seq, kind: 0, i });
  let imgUsed = 0;
  for (let i = 0; i < pt.images.length && imgUsed < MAX_IMAGES_PER_PAGE; i++, imgUsed++) evs.push({ seq: pt.images[i]!.seq, kind: 1, i });
  for (let i = 0; i < pt.items.length; i++) if (pt.items[i]!.text.trim().length > 0) evs.push({ seq: pt.items[i]!.seq, kind: 2, i });
  evs.sort((a, b) => a.seq - b.seq);

  let out = "";
  let imgCount = 0;
  let pathRun: RenderPath[] = [];
  const flushPaths = (): void => {
    if (pathRun.length) { out += renderVectors(pathRun, x0, y0, pt.wPt, pt.hPt); pathRun = []; }
  };
  for (const ev of evs) {
    if (ev.kind === 0) { pathRun.push(pt.paths[ev.i]!); continue; }
    flushPaths(); // 비-경로 요소 전에 모인 경로들을 SVG 한 덩어리로
    if (ev.kind === 2) { out += renderGlyph(pt.items[ev.i]!, x0, y0, pt.hPt, editable ? { pi: index, ii: ev.i } : undefined); continue; }
    // 이미지
    const ip = pt.images[ev.i]! as ImagePlacement;
    let img = imgCache.get(ip.stream);
    if (img === undefined) { try { img = buildImage(doc, ip.stream, ip.fill); } catch { img = null; } imgCache.set(ip.stream, img); }
    if (img) { out += renderImage(img, ip.ctm, x0, y0, pt.hPt); imgCount++; }
    else {
      const box = placeholderBox(ip.ctm, x0, y0, pt.hPt);
      if (box.w >= 24 && box.h >= 24) {
        out += `<div class="pdf-imgph" style="left:${box.left.toFixed(1)}px;top:${box.top.toFixed(1)}px;` +
          `width:${box.w.toFixed(1)}px;height:${box.h.toFixed(1)}px">${imageLabel(doc, ip.stream)}</div>`;
        imgCount++;
      }
    }
  }
  flushPaths();

  const empty = pt.items.length === 0 && imgCount === 0 && pt.paths.length === 0
    ? `<div class="pdf-empty">표시할 내용이 없습니다(미지원 이미지 포맷일 수 있음).</div>`
    : "";

  const rot = pt.rotate ? ` style="--pw:${wPx}px;--ph:${hPx}px;transform:rotate(${pt.rotate}deg)"` :
    ` style="--pw:${wPx}px;--ph:${hPx}px"`;
  return `<section class="pdf-page"${rot} data-page="${index + 1}">${out}${empty}</section>`;
}

/** 미리보기 기본 페이지 상한 — 수백 페이지 PDF 가 브라우저를 멈추지 않게(글자당 1 span). */
const DEFAULT_MAX_PAGES = 60;

export function pdfToPreviewHtml(bytes: Uint8Array, opts: PreviewOptions = {}): string {
  const doc = new PdfDocument(bytes);
  const allPages = doc.getPages();
  const maxPages = Math.max(1, opts.maxPages ?? DEFAULT_MAX_PAGES);
  const pages: PageText[] = allPages.slice(0, maxPages).map((page) => {
    const g = pageGeom(doc, page);
    const resources = doc.getDict(doc.get(page, "Resources"));
    try {
      return extractPageText(doc, pageContent(doc, page), resources, { wPt: g.wPt, hPt: g.hPt, rotate: g.rotate, x0: g.x0, y0: g.y0 });
    } catch {
      return { wPt: g.wPt, hPt: g.hPt, rotate: g.rotate, x0: g.x0, y0: g.y0, items: [], images: [], paths: [] };
    }
  });
  return composePdfHtml(doc, pages, allPages.length, opts, !!(opts as { editable?: boolean }).editable);
}

/** 미리보기 편집용: 이미 추출한 모델을 렌더(editable 기본 true). 데모 편집 흐름에서 모델 공유. */
export function pdfModelToPreviewHtml(model: PdfEditModel, opts: PreviewOptions & { editable?: boolean } = {}): string {
  return composePdfHtml(model.doc, model.pages, model.pages.length, opts, opts.editable !== false);
}

/** doc + 추출된 pages → 완결 미리보기 HTML (pdfToPreviewHtml / 모델 렌더 공용). */
function composePdfHtml(doc: PdfDocument, pages: PageText[], totalPages: number, opts: PreviewOptions, editable: boolean): string {
  const imgCache = new Map<PStream, PdfImage | null>();
  const truncated = totalPages > pages.length;
  const body = pages.map((pt, i) => renderPage(doc, pt, i, imgCache, editable)).join("\n");

  const truncBanner = truncated
    ? `<div class="pdf-banner pdf-banner-info">📄 총 ${totalPages}페이지 중 처음 ${pages.length}페이지만 미리보기로 표시합니다. ` +
      `(전체를 보려면 maxPages 옵션을 늘리세요 — 페이지가 많으면 느려질 수 있습니다.)</div>`
    : "";

  // 암호화(AES 등 미지원) → 깨진 바이트라 텍스트·이미지가 안 나옴. 분명히 안내.
  const encBanner = doc.encryptedUnsupported
    ? `<div class="pdf-banner">🔒 이 PDF 는 지원하지 않는 방식(AES)으로 암호화되어 내용을 표시할 수 없습니다. ` +
      `암호 없이 열리는 RC4 암호화는 지원합니다.</div>`
    : "";
  const note = pages.length === 0
    ? `<div class="pdf-empty">페이지를 찾을 수 없습니다(손상되었거나 미지원 암호화 PDF일 수 있음).</div>`
    : "";

  const css = `
  body { background:#eceef0; padding:28px 0; }
  .pdf-page {
    position: relative; box-sizing: border-box;
    width: var(--pw); height: var(--ph);
    margin: 0 auto 22px; background:#fff;
    box-shadow: 0 1px 4px rgba(0,0,0,.12), 0 8px 24px rgba(0,0,0,.10);
    overflow: hidden;
  }
  /* 벡터(표 테두리·배경칠·선·도형). 페이지를 덮는 SVG. */
  .pdf-vec { position: absolute; left: 0; top: 0; overflow: visible; pointer-events: none; }
  /* 이미지(텍스트 뒤). 픽셀박스를 transform 으로 장치크기에 매핑 → 조각이 이음매 없이 맞물림. */
  .pdf-img { position: absolute; left: 0; top: 0; transform-origin: 0 0; image-rendering: auto; }
  /* 미지원 이미지 자리표시(형식·크기 라벨). */
  .pdf-imgph { position: absolute; box-sizing: border-box; border: 1px dashed #c4b5a0;
    background: repeating-linear-gradient(45deg, #faf7f2, #faf7f2 8px, #f3ede2 8px, #f3ede2 16px);
    color: #8a7a5c; font-size: 11px; display: flex; align-items: center; justify-content: center;
    text-align: center; overflow: hidden; padding: 4px; }
  /* 절대배치 텍스트 — 공백 보존, 줄바꿈 금지(원점이 곧 위치). 이미지 위에 얹힌다. */
  .pdf-t {
    position: absolute; white-space: pre; line-height: 1;
    font-family: -apple-system, "Times New Roman", "Malgun Gothic", serif;
    color:#111; transform-origin: left bottom;
  }
  .pdf-empty { position:absolute; inset:0; display:flex; align-items:center; justify-content:center;
    color:#9aa0a6; font-size:13px; padding:24px; text-align:center; }
  .pdf-banner { max-width:760px; margin:0 auto 18px; padding:12px 16px; border-radius:8px;
    background:#fff7ed; border:1px solid #fdba74; color:#9a3412; font-size:13px; }
  .pdf-banner-info { background:#eff6ff; border-color:#93c5fd; color:#1e40af; }
  /* 편집 가능 글자: 호버/포커스 시 옅은 강조(클릭해서 수정). */
  .pdf-edit { outline: none; cursor: text; border-radius: 2px; }
  .pdf-edit:hover { background: rgba(91,108,255,.12); }
  .pdf-edit:focus { background: rgba(91,108,255,.22); box-shadow: 0 0 0 1px rgba(91,108,255,.5); }
  `;
  return toPreviewHtml(`<div class="pdf-wrap">${encBanner}${truncBanner}${note}${body}</div>`, {
    ...opts,
    css: (opts.css ? opts.css : "") + css,
  });
}

/** 추출된 편집 모델 — 페이지별 글자/이미지/경로 + 이미지 임베딩용 doc. */
export interface PdfEditModel {
  doc: PdfDocument;
  pages: PageText[];
}

/**
 * PDF → 편집 모델. pages[i].items[j].text 를 고치고 buildPdfFromModel 로 다시 PDF 화 한다
 * ("미리보기 편집 → 새 PDF"). 편집 흐름이라 maxPages 캡 없이 전체 페이지를 추출한다.
 */
export function extractPdfModel(bytes: Uint8Array, opts: { maxPages?: number } = {}): PdfEditModel {
  const doc = new PdfDocument(bytes);
  const all = doc.getPages();
  const limit = opts.maxPages && opts.maxPages > 0 ? Math.min(all.length, opts.maxPages) : all.length;
  const pages: PageText[] = all.slice(0, limit).map((page) => {
    const g = pageGeom(doc, page);
    const resources = doc.getDict(doc.get(page, "Resources"));
    try {
      return extractPageText(doc, pageContent(doc, page), resources, { wPt: g.wPt, hPt: g.hPt, rotate: g.rotate, x0: g.x0, y0: g.y0 });
    } catch {
      return { wPt: g.wPt, hPt: g.hPt, rotate: g.rotate, x0: g.x0, y0: g.y0, items: [], images: [], paths: [] };
    }
  });
  return { doc, pages };
}

/** 편집 모델 → 새 PDF 바이트(텍스트는 비임베딩 Helvetica/CID, 이미지·벡터 재방출). */
export function buildPdfFromModel(model: PdfEditModel): Uint8Array {
  return buildPdf(model.doc, model.pages);
}

export const pdfAdapter: FormatAdapter = {
  id: "pdf",
  label: "PDF 문서 (.pdf)",
  supportsRoundTrip: false,
  detect() {
    // PDF 는 zip part 가 아니라 %PDF 바이트로 판별(registry 가 컨테이너로 라우팅).
    return false;
  },
  encode() {
    return notImplemented("pdf", "encode");
  },
  decode() {
    return notImplemented("pdf", "decode");
  },
  toPreviewHtml(bytes, opts) {
    return pdfToPreviewHtml(bytes, (opts ?? {}) as PreviewOptions);
  },
};
