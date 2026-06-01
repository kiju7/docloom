/**
 * PDF 생성기 — 추출 모델(PageText)을 다시 PDF 로 직렬화한다("미리보기 편집 → 새 PDF").
 *
 * 핵심: 추출은 글자마다 **절대좌표**이므로, 새 PDF 도 각 글자를 그 좌표에 직접 배치한다
 * (Tm 으로 위치 지정). 따라서 폰트 폭이 레이아웃에 영향을 주지 않아 **폰트 임베딩이 불필요**:
 *   - ASCII  → 표준 Helvetica(Base-14, 비임베딩)
 *   - 비ASCII → 비임베딩 CID 폰트(HYSMyeongJo + UniKS-UCS2-H, 코드=UCS-2). 뷰어가 한글 대체렌더.
 * 굵기는 텍스트 렌더모드 2(채움+선)로 근사한다(볼드 변형 폰트 없이).
 *
 * 좌표: PageText 의 글자/경로는 이미 PDF 장치공간(y 위쪽)이고, 이미지는 CTM 이 단위정사각형을
 * 장치공간에 보낸다 → 그대로 `cm`/Tm 으로 재방출(좌표 변환 거의 없음). 그리기 순서(seq)도 보존.
 */
import { zlibSync } from "fflate";
import type { PageText, TextItem, RenderPath, ImagePlacement } from "./pdfText.js";
import type { PdfDocument } from "./pdfObjects.js";
import { extractRaster } from "./pdfImages.js";

const te = new TextEncoder();

/** 누적 객체로 PDF 바이트를 조립(번호 1..N, xref/trailer 포함). */
class PdfOut {
  private objs: Uint8Array[] = []; // index 0 → 객체1
  alloc(): number {
    this.objs.push(new Uint8Array(0));
    return this.objs.length;
  }
  set(num: number, body: Uint8Array | string): void {
    this.objs[num - 1] = typeof body === "string" ? te.encode(body) : body;
  }
  add(body: Uint8Array | string): number {
    const n = this.alloc();
    this.set(n, body);
    return n;
  }
  /** dict(문자열) + 스트림 바이트 → 객체. Flate 압축. */
  addStream(dictNoLength: string, data: Uint8Array, compress = true): number {
    const body = compress ? zlibSync(data) : data; // PDF FlateDecode = zlib 래핑(raw deflate 아님)
    const filter = compress ? " /Filter /FlateDecode" : "";
    const head = te.encode(`<< ${dictNoLength}${filter} /Length ${body.length} >>\nstream\n`);
    const tail = te.encode("\nendstream");
    const buf = new Uint8Array(head.length + body.length + tail.length);
    buf.set(head, 0); buf.set(body, head.length); buf.set(tail, head.length + body.length);
    return this.add(buf);
  }
  build(rootNum: number): Uint8Array {
    const parts: Uint8Array[] = [];
    let offset = 0;
    const push = (b: Uint8Array) => { parts.push(b); offset += b.length; };
    const offsets: number[] = [];
    push(te.encode("%PDF-1.7\n"));
    push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); // % + 바이너리 표식(고바이트)

    for (let i = 0; i < this.objs.length; i++) {
      offsets[i] = offset;
      push(te.encode(`${i + 1} 0 obj\n`));
      push(this.objs[i]!);
      push(te.encode("\nendobj\n"));
    }
    const xrefStart = offset;
    let xref = `xref\n0 ${this.objs.length + 1}\n0000000000 65535 f \n`;
    for (let i = 0; i < this.objs.length; i++) xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
    push(te.encode(xref));
    push(te.encode(`trailer\n<< /Size ${this.objs.length + 1} /Root ${rootNum} 0 R >>\nstartxref\n${xrefStart}\n%%EOF`));
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }
}

const fmt = (n: number): string => (Number.isFinite(n) ? (Math.round(n * 100) / 100).toString() : "0");
const escLatin = (s: string): string => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
const hex2 = (n: number): string => n.toString(16).padStart(4, "0").slice(-4);

/** 한 글자가 ASCII(Helvetica) 인지. 아니면 CID(UCS-2). */
const isAscii = (s: string): boolean => {
  const c = s.codePointAt(0) ?? 0;
  return c >= 0x20 && c < 0x7f;
};

/** PageText[] → PDF 바이트. doc 는 이미지 원본 스트림 디코드에 필요. */
export function buildPdf(doc: PdfDocument, pages: PageText[]): Uint8Array {
  const out = new PdfOut();

  // 공용 폰트: Helvetica / Helvetica-Bold / CID(HYSMyeongJo, 비임베딩) / CID-Bold 동일
  const fHelv = out.add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const fHelvB = out.add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  const cidDesc = out.add(
    "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /HYSMyeongJo-Medium " +
      "/CIDSystemInfo << /Registry (Adobe) /Ordering (Korea1) /Supplement 1 >> /DW 1000 >>",
  );
  const fCID = out.add(
    `<< /Type /Font /Subtype /Type0 /BaseFont /HYSMyeongJo-Medium /Encoding /UniKS-UCS2-H /DescendantFonts [${cidDesc} 0 R] >>`,
  );
  const fontRes = `<< /F1 ${fHelv} 0 R /F2 ${fCID} 0 R /F3 ${fHelvB} 0 R >>`;

  const pageRefs: number[] = [];
  const pagesNum = out.alloc(); // /Pages 먼저 번호 확보(Kids 참조 위해)

  for (const pt of pages) {
    // 이미지 XObject 등록(같은 스트림 캐시)
    const imgNames = new Map<ImagePlacement, string>();
    const xobjEntries: string[] = [];
    let imgIdx = 0;
    for (const ip of pt.images) {
      const ras = (() => { try { return extractRaster(doc, ip.stream, ip.fill); } catch { return null; } })();
      if (!ras) continue;
      const name = `Im${imgIdx++}`;
      let xnum: number;
      const common = `/Type /XObject /Subtype /Image /Width ${ras.w} /Height ${ras.h} /BitsPerComponent 8`;
      if (ras.jpeg) {
        const cs = ras.comps === 1 ? "/DeviceGray" : ras.comps === 4 ? "/DeviceCMYK" : "/DeviceRGB";
        xnum = out.addStream(`${common} /ColorSpace ${cs} /Filter /DCTDecode`, ras.jpeg, false);
      } else {
        let smaskRef = "";
        if (ras.alpha) {
          const sm = out.addStream(`${common} /ColorSpace /DeviceGray`, ras.alpha);
          smaskRef = ` /SMask ${sm} 0 R`;
        }
        xnum = out.addStream(`${common} /ColorSpace /DeviceRGB${smaskRef}`, ras.rgb!);
      }
      imgNames.set(ip, name);
      xobjEntries.push(`/${name} ${xnum} 0 R`);
    }

    const content = buildContent(pt, imgNames);
    const contentNum = out.addStream("", te.encode(content));
    const xobjRes = xobjEntries.length ? ` /XObject << ${xobjEntries.join(" ")} >>` : "";
    const x0 = pt.x0 || 0, y0 = pt.y0 || 0;
    const pageNum = out.add(
      `<< /Type /Page /Parent ${pagesNum} 0 R /MediaBox [${fmt(x0)} ${fmt(y0)} ${fmt(x0 + pt.wPt)} ${fmt(y0 + pt.hPt)}] ` +
        `/Resources << /Font ${fontRes}${xobjRes} >> /Contents ${contentNum} 0 R >>`,
    );
    pageRefs.push(pageNum);
  }

  out.set(pagesNum, `<< /Type /Pages /Kids [${pageRefs.map((n) => `${n} 0 R`).join(" ")}] /Count ${pageRefs.length} >>`);
  const root = out.add(`<< /Type /Catalog /Pages ${pagesNum} 0 R >>`);
  return out.build(root);
}

/** 한 페이지의 콘텐츠 스트림(그리기순서 seq 보존: 이미지·경로·텍스트 병합). */
function buildContent(pt: PageText, imgNames: Map<ImagePlacement, string>): string {
  type Ev = { seq: number; kind: 0 | 1 | 2; i: number };
  const evs: Ev[] = [];
  for (let i = 0; i < pt.paths.length; i++) evs.push({ seq: pt.paths[i]!.seq, kind: 0, i });
  for (let i = 0; i < pt.images.length; i++) evs.push({ seq: pt.images[i]!.seq, kind: 1, i });
  for (let i = 0; i < pt.items.length; i++) if (pt.items[i]!.text.trim()) evs.push({ seq: pt.items[i]!.seq, kind: 2, i });
  evs.sort((a, b) => a.seq - b.seq);

  let s = "";
  let inText = false;
  const endText = () => { if (inText) { s += "ET\n"; inText = false; } };

  for (const ev of evs) {
    if (ev.kind === 2) {
      if (!inText) { s += "BT\n"; inText = true; }
      s += emitRun(pt.items[ev.i]!);
      continue;
    }
    endText();
    if (ev.kind === 0) s += emitPath(pt.paths[ev.i]!);
    else {
      const ip = pt.images[ev.i]!;
      const name = imgNames.get(ip);
      if (name) { const m = ip.ctm; s += `q ${fmt(m[0]!)} ${fmt(m[1]!)} ${fmt(m[2]!)} ${fmt(m[3]!)} ${fmt(m[4]!)} ${fmt(m[5]!)} cm /${name} Do Q\n`; }
    }
  }
  endText();
  return s;

  // ── 텍스트 런: 원점에 Tm, 스크립트(ASCII/CJK) 경계로 폰트 전환하며 흐르게 출력 ──
  function emitRun(it: TextItem): string {
    let g = `1 0 0 1 ${fmt(it.x)} ${fmt(it.y)} Tm\n`;
    // 굵기: ASCII 는 Helvetica-Bold(F3), CID 는 렌더모드2 근사.
    for (const seg of splitByScript(it.text)) {
      const ascii = seg.ascii;
      const font = ascii ? (it.bold ? "/F3" : "/F1") : "/F2";
      g += `${font} ${fmt(it.size)} Tf\n`;
      const cidBold = it.bold && !ascii;
      if (cidBold) g += `2 Tr ${fmt(it.size * 0.03)} w\n`;
      if (ascii) g += `(${escLatin(seg.text)}) Tj\n`;
      else g += `<${[...seg.text].map((ch) => hex2(ch.codePointAt(0) ?? 0)).join("")}> Tj\n`;
      if (cidBold) g += "0 Tr\n";
    }
    return g;
  }
}

/** 텍스트를 ASCII / 비ASCII(CJK 등) 연속 구간으로 분할. */
function splitByScript(text: string): { ascii: boolean; text: string }[] {
  const segs: { ascii: boolean; text: string }[] = [];
  for (const ch of text) {
    const a = isAscii(ch);
    const last = segs[segs.length - 1];
    if (last && last.ascii === a) last.text += ch;
    else segs.push({ ascii: a, text: ch });
  }
  return segs;
}

function emitPath(p: RenderPath): string {
  let d = "";
  for (const cm of p.cmds) {
    if (cm.t === "M") d += `${fmt(cm.c[0]!)} ${fmt(cm.c[1]!)} m\n`;
    else if (cm.t === "L") d += `${fmt(cm.c[0]!)} ${fmt(cm.c[1]!)} l\n`;
    else if (cm.t === "C") d += `${fmt(cm.c[0]!)} ${fmt(cm.c[1]!)} ${fmt(cm.c[2]!)} ${fmt(cm.c[3]!)} ${fmt(cm.c[4]!)} ${fmt(cm.c[5]!)} c\n`;
    else d += "h\n";
  }
  if (!d) return "";
  let s = "q\n";
  const rgb = (c: [number, number, number]) => `${fmt(c[0] / 255)} ${fmt(c[1] / 255)} ${fmt(c[2] / 255)}`;
  if (p.fill) s += `${rgb(p.fill)} rg\n`;
  if (p.stroke) s += `${rgb(p.stroke)} RG\n${fmt(Math.max(p.lineWidth, 0.2))} w\n`;
  s += d;
  if (p.fill && p.stroke) s += p.evenOdd ? "B*\n" : "B\n";
  else if (p.fill) s += p.evenOdd ? "f*\n" : "f\n";
  else s += "S\n";
  s += "Q\n";
  return s;
}
