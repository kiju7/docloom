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
import { PdfDocument, PStream, PName, type PDict, type PdfValue } from "../core/pdf/pdfObjects.js";
import { extractPageText, type PageText, type ImagePlacement, type RenderPath, type ClipRect } from "../core/pdf/pdfText.js";
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
function renderImage(img: PdfImage, ctm: number[], x0: number, y0: number, hPt: number, clip?: ClipRect, alpha?: number): string {
  const op = alpha !== undefined && alpha < 1 ? `;opacity:${alpha.toFixed(3)}` : "";
  const [a, b, c, d, e, f] = ctm;
  const W = img.w, H = img.h;
  const s = PT2PX;
  // 로컬 픽셀(x∈[0,W], y∈[0,H], y 아래쪽) → CSS px. (u=x/W, v=1-y/H 대입 후 정리)
  const A = (s * a!) / W;
  const B = (-s * b!) / W;
  const C = (-s * c!) / H;
  const D = (s * d!) / H;
  let E = s * (c! + e! - x0);
  let F = s * (hPt + y0 - d! - f!);
  const t = (n: number) => (Number.isFinite(n) ? n.toFixed(4) : "0");
  // 클립(W)이 있으면 클립 사각형 크기의 overflow:hidden 래퍼로 감싸 칸 밖을 잘라낸다.
  // 래퍼 안쪽 원점이 (clipLeft, clipTop) 이므로 이미지 평행이동(E,F)을 그만큼 당겨준다.
  if (clip) {
    const cl = (clip[0] - x0) * s, cr = (clip[2] - x0) * s;
    const ct = (hPt - (clip[3] - y0)) * s, cb = (hPt - (clip[1] - y0)) * s;
    E -= cl; F -= ct;
    const imgEl = `<img class="pdf-img" src="${img.uri}" width="${W}" height="${H}" alt="" style="transform:matrix(${t(A)},${t(B)},${t(C)},${t(D)},${t(E)},${t(F)})${op}">`;
    return `<div class="pdf-clip" style="position:absolute;left:${cl.toFixed(2)}px;top:${ct.toFixed(2)}px;` +
      `width:${(cr - cl).toFixed(2)}px;height:${(cb - ct).toFixed(2)}px;overflow:hidden">${imgEl}</div>`;
  }
  return (
    `<img class="pdf-img" src="${img.uri}" width="${W}" height="${H}" alt="" ` +
    `style="transform:matrix(${t(A)},${t(B)},${t(C)},${t(D)},${t(E)},${t(F)})${op}">`
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

/** clipPath ID 전역 카운터 — 한 문서 내 모든 SVG 에서 유일해야 url(#..) 충돌이 없다. */
let __clipUid = 0;

/** 벡터 경로들 → 페이지를 덮는 SVG(표 테두리·배경칠·선·도형). */
function renderVectors(paths: RenderPath[], x0: number, y0: number, wPt: number, hPt: number): string {
  if (paths.length === 0) return "";
  const wPx = wPt * PT2PX, hPx = hPt * PT2PX;
  const s = PT2PX;
  const cx = (x: number) => ((x - x0) * s).toFixed(2);
  const cy = (y: number) => ((hPt - (y - y0)) * s).toFixed(2); // PDF y-up → CSS y-down
  const rgb = (c: [number, number, number]) => `rgb(${c[0]},${c[1]},${c[2]})`;
  const CAP = ["butt", "round", "square"];
  const JOIN = ["miter", "round", "bevel"];
  let defs = "";
  let els = "";
  for (const p of paths) {
    let d = "";
    // 경로 bbox(PDF 좌표) — 클립이 이 bbox 를 완전히 덮으면 클립은 무의미하므로 생략.
    let pminX = Infinity, pminY = Infinity, pmaxX = -Infinity, pmaxY = -Infinity;
    const acc = (x: number, y: number) => { if (x < pminX) pminX = x; if (x > pmaxX) pmaxX = x; if (y < pminY) pminY = y; if (y > pmaxY) pmaxY = y; };
    for (const cm of p.cmds) {
      if (cm.t === "M") { d += `M${cx(cm.c[0]!)} ${cy(cm.c[1]!)}`; acc(cm.c[0]!, cm.c[1]!); }
      else if (cm.t === "L") { d += `L${cx(cm.c[0]!)} ${cy(cm.c[1]!)}`; acc(cm.c[0]!, cm.c[1]!); }
      else if (cm.t === "C") { d += `C${cx(cm.c[0]!)} ${cy(cm.c[1]!)} ${cx(cm.c[2]!)} ${cy(cm.c[3]!)} ${cx(cm.c[4]!)} ${cy(cm.c[5]!)}`; acc(cm.c[0]!, cm.c[1]!); acc(cm.c[2]!, cm.c[3]!); acc(cm.c[4]!, cm.c[5]!); }
      else d += "Z";
    }
    if (!d) continue;
    const fill = p.fill ? rgb(p.fill) : "none";
    const stroke = p.stroke ? rgb(p.stroke) : "none";
    const sw = p.stroke ? Math.max(p.lineWidth * s, 0.5).toFixed(2) : "0";
    const fr = p.evenOdd ? ` fill-rule="evenodd"` : "";
    const fo = p.fillAlpha !== undefined && p.fill ? ` fill-opacity="${p.fillAlpha.toFixed(3)}"` : "";
    const so = p.strokeAlpha !== undefined && p.stroke ? ` stroke-opacity="${p.strokeAlpha.toFixed(3)}"` : "";
    // 파선(장치단위 → px)·선끝·선이음
    const dashAttr = p.dash && p.dash.length
      ? ` stroke-dasharray="${p.dash.map((v) => (v * s).toFixed(2)).join(",")}"${p.dashPhase ? ` stroke-dashoffset="${(p.dashPhase * s).toFixed(2)}"` : ""}`
      : "";
    const capAttr = p.cap ? ` stroke-linecap="${CAP[p.cap] ?? "butt"}"` : "";
    const joinAttr = p.join ? ` stroke-linejoin="${JOIN[p.join] ?? "miter"}"` : "";
    // 클립: 축정렬 사각형을 clipPath 로 정의해 경로에 건다(칸 밖 칠 잘라냄).
    // ID 는 전역 유일(__clipUid)해야 한다 — 한 페이지에 SVG 가 여러 개 생기는데 SVG마다 pc0 으로
    // 재시작하면 url(#pc0) 가 첫 정의로 해석돼 엉뚱하게 잘림(표 셀 배경이 사라지던 버그).
    // 또 클립이 경로 bbox 를 완전히 덮으면(셀 칠처럼) 무의미하므로 생략한다.
    let clipAttr = "";
    if (p.clip) {
      const eps = 0.5;
      const covers = p.clip[0] <= pminX + eps && p.clip[1] <= pminY + eps && p.clip[2] >= pmaxX - eps && p.clip[3] >= pmaxY - eps;
      if (!covers) {
        const cl = (p.clip[0] - x0) * s, cr = (p.clip[2] - x0) * s;
        const ct = (hPt - (p.clip[3] - y0)) * s, cb = (hPt - (p.clip[1] - y0)) * s;
        if (cr - cl > 0.1 && cb - ct > 0.1) {
          const id = `pc${__clipUid++}`;
          defs += `<clipPath id="${id}"><rect x="${cl.toFixed(2)}" y="${ct.toFixed(2)}" width="${(cr - cl).toFixed(2)}" height="${(cb - ct).toFixed(2)}"/></clipPath>`;
          clipAttr = ` clip-path="url(#${id})"`;
        }
      }
    }
    els += `<path d="${d}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"${fr}${fo}${so}${dashAttr}${capAttr}${joinAttr}${clipAttr}/>`;
  }
  const defsEl = defs ? `<defs>${defs}</defs>` : "";
  return `<svg class="pdf-vec" width="${wPx}" height="${hPx}" viewBox="0 0 ${wPx} ${hPx}">${defsEl}${els}</svg>`;
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
  // 회전/전단 글자: CSS matrix 로 기울인다. 회전된 칸은 가로폭 흐름맞춤(data-w squeeze)을 적용하지
  // 않는다(matrix 가 이미 실제 가로배율 a 를 포함 — 둘이 같은 transform 을 다투면 안 됨).
  const rotated = !!it.rot;
  // 원본 런 폭(px) — 대체폰트가 더 넓게 그려지면 스크립트가 이 폭으로 scaleX 압축(잘림/겹침 방지).
  const wAttr = !rotated && it.w && it.w > 0 ? ` data-w="${(it.w * PT2PX).toFixed(1)}"` : "";
  // 임베디드 폰트 글자만 폭에 맞춰 "늘리기"까지 허용(원본폭에 근접해 소폭 보정). 비임베디드
  // 대체폰트는 폭차가 커서 늘리면 가로로 왜곡됨 → 늘리지 않고 좁히기만(표 안 라틴 텍스트 보호).
  const embAttr = !rotated && it.ff && it.w && it.w > 0 ? ` data-emb="1"` : "";
  // 임베디드 폰트가 있으면 그 family 를 앞세우고, 없는 글리프는 대체 스택으로 폴백.
  // 주의: 인라인 style 은 큰따옴표로 감싸므로 폰트명도 작은따옴표로(큰따옴표면 style 속성이
  // 조기 종료돼 뒤의 color 등이 통째로 무시됨 — 색 안 먹던 버그의 원인).
  const ff = it.ff ? `font-family:'${it.ff}',-apple-system,'Malgun Gothic',serif;` : "";
  const op = it.alpha !== undefined && it.alpha < 1 ? `opacity:${it.alpha.toFixed(3)};` : "";
  // 글자색(추출한 fill/stroke 색). 없으면 CSS 기본(#111). 거의 검정도 그대로 #000 으로 명시.
  const col = it.color ? `color:rgb(${it.color[0]},${it.color[1]},${it.color[2]});` : "";
  let rotStyle = "";
  if (it.rot) {
    const r = it.rot;
    const f4 = (n: number) => (Number.isFinite(n) ? n.toFixed(5) : "0");
    // 회전축은 글자 원점(좌측·베이스라인). 베이스라인은 span 상단에서 sizePx*0.82 아래.
    rotStyle = `transform-origin:0 ${(sizePx * 0.82).toFixed(2)}px;transform:matrix(${f4(r[0])},${f4(r[1])},${f4(r[2])},${f4(r[3])},0,0);`;
  }
  return (
    `<span class="pdf-t${ed ? " pdf-edit" : ""}"${editAttr}${wAttr}${embAttr} style="left:${left.toFixed(2)}px;top:${top.toFixed(2)}px;` +
    `font-size:${sizePx.toFixed(2)}px;${ff}${w}${st}${col}${op}${rotStyle}">${esc(it.text)}</span>`
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
    if (img) { out += renderImage(img, ip.ctm, x0, y0, pt.hPt, ip.clip, ip.alpha); imgCount++; }
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

  // rotate 는 인라인 기본값(스크립트 미동작 시에도 유지), data-rot 로 스크립트가 scale 과 합성.
  const rotAttr = pt.rotate ? ` data-rot="${pt.rotate}"` : "";
  const tf = pt.rotate ? `;transform:rotate(${pt.rotate}deg)` : "";
  // .pdf-fit 래퍼: fit-to-width 스크립트가 축소 시 래퍼 높이를 줄여 페이지가 빈틈없이 쌓이게 한다.
  // 스크립트가 없으면 래퍼는 원본 크기 그대로(폴백).
  return `<div class="pdf-fit"><section class="pdf-page"${rotAttr} style="--pw:${wPx}px;--ph:${hPx}px${tf}" data-page="${index + 1}">${out}${empty}</section></div>`;
}

/**
 * 미리보기 기본 페이지 상한. 벡터로 글자를 그린 PDF 는 페이지당 경로가 수천 개라 한 페이지가
 * 수백 KB HTML 이 된다 → 한 번에 적게 그리고 "더보기"(extendPdfModel)로 이어 보게 한다.
 */
const DEFAULT_MAX_PAGES = 20;

/**
 * 페이지 /Annots 중 외관 스트림(/AP /N)을 가진 주석 → {Form XObject, ctm}.
 * ctm 은 외관 BBox(Matrix 적용 후)를 주석 Rect 로 보내는 사상(PDF 12.5.5). 숨김/뷰숨김·
 * Popup·외관없는 Link 는 건너뛴다. 결과는 페이지 콘텐츠 위층에 그려진다.
 */
function annotAppearances(doc: PdfDocument, page: PDict): { stream: PStream; ctm: number[]; resources?: PDict }[] {
  const out: { stream: PStream; ctm: number[]; resources?: PDict }[] = [];
  const annots = doc.resolve(doc.get(page, "Annots"));
  if (!Array.isArray(annots)) return out;
  const n = (v: PdfValue) => doc.numOf(v, 0);
  for (const aRef of annots.slice(0, 2000)) {
    const an = doc.getDict(aRef);
    if (!an) continue;
    const flags = doc.numOf(doc.get(an, "F"), 0);
    if (flags & 0x2 || flags & 0x20) continue; // Hidden(bit2) / NoView(bit6)
    const ap = doc.getDict(doc.get(an, "AP"));
    if (!ap) continue;
    let nAp = doc.resolve(doc.get(ap, "N"));
    // /N 이 외관상태별 하위딕셔너리면 /AS 로 고른다(체크박스 On/Off 등).
    if (nAp && !(nAp instanceof PStream)) {
      const asName = doc.get(an, "AS");
      const sub = doc.getDict(nAp);
      const key = asName instanceof PName ? asName.name : sub ? Object.keys(sub)[0] : undefined;
      nAp = key ? doc.resolve(doc.get(sub, key)) : null;
    }
    if (!(nAp instanceof PStream)) continue;
    const rect = doc.resolve(doc.get(an, "Rect"));
    if (!Array.isArray(rect) || rect.length !== 4) continue;
    const rx0 = Math.min(n(rect[0]!), n(rect[2]!)), rx1 = Math.max(n(rect[0]!), n(rect[2]!));
    const ry0 = Math.min(n(rect[1]!), n(rect[3]!)), ry1 = Math.max(n(rect[1]!), n(rect[3]!));
    const bboxA = doc.resolve(doc.get(nAp.dict, "BBox"));
    if (!Array.isArray(bboxA) || bboxA.length !== 4) continue;
    const mtxA = doc.resolve(doc.get(nAp.dict, "Matrix"));
    const M: number[] = Array.isArray(mtxA) && mtxA.length === 6 ? mtxA.map((v) => n(v)) : [1, 0, 0, 1, 0, 0];
    // BBox 네 모서리를 Matrix 로 변환 → 변환된 경계상자.
    const bx = [n(bboxA[0]!), n(bboxA[2]!)], by = [n(bboxA[1]!), n(bboxA[3]!)];
    const xs: number[] = [], ys: number[] = [];
    for (const X of bx) for (const Y of by) { xs.push(M[0]! * X + M[2]! * Y + M[4]!); ys.push(M[1]! * X + M[3]! * Y + M[5]!); }
    const tx0 = Math.min(...xs), tx1 = Math.max(...xs), ty0 = Math.min(...ys), ty1 = Math.max(...ys);
    const sx = tx1 - tx0 > 1e-6 ? (rx1 - rx0) / (tx1 - tx0) : 1;
    const sy = ty1 - ty0 > 1e-6 ? (ry1 - ry0) / (ty1 - ty0) : 1;
    // A: 변환된 BBox → Rect (스케일+평행이동). 최종 ctm = M 먼저, 그다음 A.
    const A = [sx, 0, 0, sy, rx0 - sx * tx0, ry0 - sy * ty0];
    const ctm = [
      M[0]! * A[0]! + M[1]! * A[2]!, M[0]! * A[1]! + M[1]! * A[3]!,
      M[2]! * A[0]! + M[3]! * A[2]!, M[2]! * A[1]! + M[3]! * A[3]!,
      M[4]! * A[0]! + M[5]! * A[2]! + A[4]!, M[4]! * A[1]! + M[5]! * A[3]! + A[5]!,
    ];
    out.push({ stream: nAp, ctm, resources: doc.getDict(doc.get(nAp.dict, "Resources")) });
  }
  return out;
}

/** 한 페이지 → PageText. 추출 실패해도 기하만 채운 빈 페이지를 돌려 렌더가 안 끊기게. */
function extractOnePage(doc: PdfDocument, page: PDict): PageText {
  const g = pageGeom(doc, page);
  const resources = doc.getDict(doc.get(page, "Resources"));
  try {
    const annots = (() => { try { return annotAppearances(doc, page); } catch { return []; } })();
    return extractPageText(doc, pageContent(doc, page), resources, { wPt: g.wPt, hPt: g.hPt, rotate: g.rotate, x0: g.x0, y0: g.y0 }, annots);
  } catch {
    return { wPt: g.wPt, hPt: g.hPt, rotate: g.rotate, x0: g.x0, y0: g.y0, items: [], images: [], paths: [] };
  }
}

export function pdfToPreviewHtml(bytes: Uint8Array, opts: PreviewOptions = {}): string {
  const doc = new PdfDocument(bytes);
  const allPages = doc.getPages();
  const maxPages = Math.max(1, opts.maxPages ?? DEFAULT_MAX_PAGES);
  const pages: PageText[] = allPages.slice(0, maxPages).map((page) => extractOnePage(doc, page));
  return composePdfHtml(doc, pages, allPages.length, opts, !!(opts as { editable?: boolean }).editable);
}

/** 미리보기 편집용: 이미 추출한 모델을 렌더(editable 기본 true). 데모 편집 흐름에서 모델 공유. */
export function pdfModelToPreviewHtml(model: PdfEditModel, opts: PreviewOptions & { editable?: boolean } = {}): string {
  return composePdfHtml(model.doc, model.pages, model.pages.length, opts, opts.editable !== false);
}

/**
 * 모델의 [fromPage, toPage) 페이지만 `<section>` 조각 HTML 로 렌더(완결 문서 아님).
 * "더보기"가 기존 미리보기 DOM 끝에 그대로 이어 붙이는 용도 — data-pi 는 절대 페이지번호.
 */
export function pdfModelPagesHtml(model: PdfEditModel, fromPage: number, toPage: number, opts: { editable?: boolean } = {}): string {
  const editable = opts.editable !== false;
  const imgCache = new Map<PStream, PdfImage | null>();
  const from = Math.max(0, fromPage);
  const to = Math.min(model.pages.length, toPage);
  let out = "";
  for (let i = from; i < to; i++) out += renderPage(model.doc, model.pages[i]!, i, imgCache, editable) + "\n";
  return out;
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
  /* fit-to-width 래퍼: 가운데 정렬 + 창보다 넓으면 넘치지 않게. 스크립트가 축소 시 폭/높이를 직접 지정. */
  .pdf-fit { width: fit-content; max-width: 100%; margin: 0 auto 22px; }
  .pdf-page {
    position: relative; box-sizing: border-box;
    width: var(--pw); height: var(--ph);
    background:#fff;
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
  // 임베디드 폰트 @font-face(파일 안 폰트 바이트를 data URI 로 인라인 → 폐쇄망 자기완결).
  const faces = [...doc.fontFaces.values()].join("\n");
  return toPreviewHtml(`<div class="pdf-wrap">${encBanner}${truncBanner}${note}${body}</div>${PDF_FIT_SCRIPT}`, {
    ...opts,
    css: (opts.css ? opts.css : "") + faces + css,
  });
}

/** 모델이 지금까지 추출한 페이지들이 쓰는 임베디드 폰트 @font-face CSS 전체("더보기" 시 주입용). */
export function pdfModelFontFaceCss(model: PdfEditModel): string {
  return [...model.doc.fontFaces.values()].join("\n");
}

/**
 * fit-to-width: A4 페이지(고정 px)가 창보다 넓으면 transform:scale 로 줄여 가로 스크롤/잘림을 막는다.
 * 원본보다 키우진 않는다(scale ≤ 1). resize 마다 재계산하고, "더보기"로 페이지를 이어 붙인 뒤
 * window.__pdfFit() 으로 다시 부를 수 있다. 회전 페이지는 기존 동작 유지(축소 미적용).
 * 스크립트가 안 돌아도(차단 등) 래퍼가 원본 크기로 폴백 — 깨지지 않고 그냥 100% 로 보인다.
 */
const PDF_FIT_SCRIPT = `<script>
(function(){
  // 각 글자조각을 원본 폭(data-w)에 scaleX 로 정확히 맞춘다(좁히기+늘리기).
  //   · 넓게 그려진 줄 → 압축(페이지 밖 잘림 방지)
  //   · 좁게 그려진 조각 → 확장(다음 조각이 절대좌표로 고정돼 있어, 안 늘리면 조각 사이 틈이 벌어짐.
  //     원본이 한 줄에서 폰트를 번갈아 써 글자단위로 쪼개진 경우 특히 띄어쓰기가 과하게 보이는 문제 해결)
  // 과도한 가로왜곡은 막으려 배율을 [0.4, 1.5] 로 제한(극단 조각은 작은 틈을 감수).
  function squeeze(root){
    var ts=(root||document).querySelectorAll('.pdf-t[data-w]');
    for(var i=0;i<ts.length;i++){
      var el=ts[i], target=parseFloat(el.getAttribute('data-w')); if(!(target>0)) continue;
      el.style.transform='none';            // 먼저 초기화하고 자연폭 측정(재호출에도 안정적)
      var natural=el.scrollWidth; if(!(natural>0)) continue;
      var s=target/natural;
      // 늘리기는 임베디드 폰트(data-emb)만 — 대체폰트를 늘리면 가로왜곡(표 안 라틴 텍스트).
      if(s>1 && !el.hasAttribute('data-emb')) s=1;
      if(s<0.4) s=0.4; else if(s>1.5) s=1.5;
      el.style.transform = (s>0.999 && s<1.001) ? '' : 'scaleX('+s+')';
    }
  }
  function fit(root){
    var fits=(root||document).querySelectorAll('.pdf-fit');
    for(var i=0;i<fits.length;i++){
      var fit=fits[i], pg=fit.querySelector('.pdf-page'); if(!pg) continue;
      if(pg.getAttribute('data-rot')) continue; // 회전 페이지는 그대로
      var pw=parseFloat(pg.style.getPropertyValue('--pw'))||pg.offsetWidth;
      var ph=parseFloat(pg.style.getPropertyValue('--ph'))||pg.offsetHeight;
      var avail=((fit.parentElement&&fit.parentElement.clientWidth)||window.innerWidth)-2;
      var s=Math.min(1, avail/pw);
      pg.style.transformOrigin='top left';
      pg.style.transform = s<1 ? 'scale('+s+')' : '';
      fit.style.width=(pw*s)+'px';
      fit.style.height=(ph*s)+'px';
    }
    squeeze(root); // 줄 압축은 페이지 스케일과 무관(폰트 폭 기준) — 한 번 더 안정화
  }
  window.__pdfFit=fit;
  window.addEventListener('resize', function(){ fit(); });
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', function(){ fit(); });
  else fit();
  // 웹폰트 로드 후 글자폭이 바뀔 수 있으니 폰트 준비되면 한 번 더.
  if(document.fonts&&document.fonts.ready) document.fonts.ready.then(function(){ fit(); });
})();
</script>`;

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
  const pages: PageText[] = all.slice(0, limit).map((page) => extractOnePage(doc, page));
  return { doc, pages };
}

/** 모델의 전체(추출 가능) 페이지 수 — "더보기" 가 남은 페이지가 있는지 판단할 때. */
export function pdfModelTotalPages(model: PdfEditModel): number {
  return model.doc.getPages().length;
}

/**
 * "더보기": 이미 추출한 모델 뒤에 다음 `count` 페이지를 추가 추출해 append.
 * 앞 페이지는 다시 파싱하지 않으므로 기존 미리보기/편집을 보존한 채 이어 그릴 수 있다.
 * 반환: 실제로 추가된 페이지 수(남은 게 없으면 0).
 */
export function extendPdfModel(model: PdfEditModel, count: number): number {
  if (count <= 0) return 0;
  const all = model.doc.getPages();
  const from = model.pages.length;
  const to = Math.min(all.length, from + count);
  for (let i = from; i < to; i++) model.pages.push(extractOnePage(model.doc, all[i]!));
  return to - from;
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
