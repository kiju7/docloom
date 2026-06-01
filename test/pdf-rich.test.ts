import { describe, it, expect } from "vitest";
import { zlibSync, unzlibSync } from "fflate";
import { previewHtml, registerImageDecoder, clearImageDecoders } from "../src/index.js";
import { md5, rc4 } from "../src/core/pdf/pdfCrypt.js";
import { lzwDecode } from "../src/core/pdf/pdfFilters.js";

const te = new TextEncoder();

function hex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

// ── 객체/스트림을 바이트로 조립하는 PDF 빌더(xref 없음 — brute-scan 으로 읽힘) ──
function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
function buildPdf(objs: { num: number; dict: string; stream?: Uint8Array }[]): Uint8Array {
  const parts: Uint8Array[] = [te.encode("%PDF-1.5\n")];
  for (const o of objs) {
    if (o.stream) {
      parts.push(te.encode(`${o.num} 0 obj ${o.dict} stream\n`));
      parts.push(o.stream);
      parts.push(te.encode(`\nendstream endobj\n`));
    } else {
      parts.push(te.encode(`${o.num} 0 obj ${o.dict} endobj\n`));
    }
  }
  parts.push(te.encode(`trailer << /Root 1 0 R >>\n%%EOF`));
  return concatBytes(parts);
}

describe("PDF 보안 프리미티브 (MD5 / RC4)", () => {
  it("MD5 표준 벡터", () => {
    expect(hex(md5(te.encode("")))).toBe("d41d8cd98f00b204e9800998ecf8427e");
    expect(hex(md5(te.encode("abc")))).toBe("900150983cd24fb0d6963f7d28e17f72");
    expect(hex(md5(te.encode("The quick brown fox jumps over the lazy dog")))).toBe(
      "9e107d9d372bb6826bd81d3542a419d6",
    );
  });
  it("RC4 표준 벡터 (key='Key', 'Plaintext')", () => {
    const ct = rc4(te.encode("Key"), te.encode("Plaintext"));
    expect(hex(ct).toUpperCase()).toBe("BBF316E8D940AF0AD3");
    // 대칭: 다시 RC4 하면 평문
    expect(new TextDecoder().decode(rc4(te.encode("Key"), ct))).toBe("Plaintext");
  });
});

describe("LZWDecode", () => {
  it("PDF 스펙 예시 (early change=1) 를 디코드", () => {
    // PDF 스펙 7.4.4.2 의 인코딩 결과 바이트열 → "-----A---B"
    const encoded = new Uint8Array([0x80, 0x0b, 0x60, 0x50, 0x22, 0x0c, 0x0c, 0x85, 0x01]);
    const out = new TextDecoder().decode(lzwDecode(encoded, 1));
    expect(out).toBe("-----A---B");
  });
});

describe("PDF 이미지 렌더링 (Flate RGB → PNG, CTM 절대배치)", () => {
  it("이미지 XObject 가 data:image/png + matrix 로 배치된다", () => {
    // 2×2 RGB: 빨강/초록/파랑/흰
    const rgb = new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]);
    const stream = zlibSync(rgb);
    const content = te.encode("q 200 0 0 100 0 0 cm /Im0 Do Q");
    const pdf = buildPdf([
      { num: 1, dict: "<< /Type /Catalog /Pages 2 0 R >>" },
      { num: 2, dict: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>" },
      { num: 3, dict: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>" },
      { num: 4, dict: `<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${stream.length} >>`, stream },
      { num: 5, dict: `<< /Length ${content.length} >>`, stream: content },
    ]);
    const html = previewHtml(pdf);
    expect(html).toContain('class="pdf-img"');
    expect(html).toContain("data:image/png;base64,");
    expect(html).toMatch(/transform:matrix\(/);
    // 빈페이지 안내가 뜨면 안 됨(이미지가 있으므로)
    expect(html).not.toContain("표시할 텍스트·이미지가 없습니다");

    // 생성된 PNG 가 실제로 유효한지: 시그니처·IHDR(2×2)·IDAT 픽셀 검증
    const b64 = /data:image\/png;base64,([A-Za-z0-9+/=]+)/.exec(html)![1]!;
    const png = Uint8Array.from(Buffer.from(b64, "base64"));
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    // IHDR width/height (8바이트 길이/타입 뒤)
    const dv = new DataView(png.buffer);
    expect(dv.getUint32(16)).toBe(2); // width
    expect(dv.getUint32(20)).toBe(2); // height
    expect(png[24]).toBe(8); // bit depth
    expect(png[25]).toBe(2); // color type 2 = RGB
    // IDAT 찾아 inflate → 행마다 [filter=0] + RGB*2. 첫 픽셀 빨강.
    let i = 8;
    let idat: Uint8Array | null = null;
    while (i < png.length) {
      const len = dv.getUint32(i);
      const type = String.fromCharCode(png[i + 4]!, png[i + 5]!, png[i + 6]!, png[i + 7]!);
      if (type === "IDAT") { idat = png.subarray(i + 8, i + 8 + len); break; }
      i += 12 + len;
    }
    expect(idat).not.toBeNull();
    const raw = unzlibSync(idat!);
    // 행 길이 = 1(filter) + 2*3(RGB) = 7
    expect(raw[0]).toBe(0); // 필터 타입
    expect([raw[1], raw[2], raw[3]]).toEqual([255, 0, 0]); // 첫 픽셀 빨강
  });

  it("쪼개진 두 이미지 조각이 각각 절대배치된다(이음매)", () => {
    const px = zlibSync(new Uint8Array([128, 128, 128])); // 1×1 회색
    const dictImg = (n: number) =>
      `<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${px.length} >>`;
    // 위/아래 절반을 각각 다른 이미지로 — y=50 경계로 맞붙음
    const content = te.encode("q 200 0 0 50 0 50 cm /ImA Do Q q 200 0 0 50 0 0 cm /ImB Do Q");
    const pdf = buildPdf([
      { num: 1, dict: "<< /Type /Catalog /Pages 2 0 R >>" },
      { num: 2, dict: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>" },
      { num: 3, dict: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /XObject << /ImA 4 0 R /ImB 6 0 R >> >> /Contents 5 0 R >>" },
      { num: 4, dict: dictImg(4), stream: px },
      { num: 5, dict: `<< /Length ${content.length} >>`, stream: content },
      { num: 6, dict: dictImg(6), stream: px },
    ]);
    const html = previewHtml(pdf);
    const imgs = html.match(/class="pdf-img"/g) ?? [];
    expect(imgs.length).toBe(2);
  });
});

describe("PDF Type0 CID 폰트 한글", () => {
  it("UniKS-UCS2-H(코드=유니코드)는 ToUnicode 없이도 한글 디코드", () => {
    // '가'=U+AC00 → 2바이트 코드 <AC00>
    const content = te.encode("BT /F1 12 Tf 10 50 Td <AC00AC01> Tj ET");
    const pdf = buildPdf([
      { num: 1, dict: "<< /Type /Catalog /Pages 2 0 R >>" },
      { num: 2, dict: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>" },
      { num: 3, dict: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>" },
      { num: 4, dict: "<< /Type /Font /Subtype /Type0 /BaseFont /HYSMyeongJo-Medium /Encoding /UniKS-UCS2-H /DescendantFonts [6 0 R] >>" },
      { num: 6, dict: "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /HYSMyeongJo-Medium /DW 1000 >>" },
      { num: 5, dict: `<< /Length ${content.length} >>`, stream: content },
    ]);
    const html = previewHtml(pdf);
    // 글리프 span 에 '가','각' 이 실려야 함
    const glyphs = [...html.matchAll(/<span class="pdf-t"[^>]*>([^<]*)<\/span>/g)].map((m) => m[1]).join("");
    expect(glyphs).toBe("가각");
  });
});

describe("PDF 굵기/기울임 + 그리기순서 층위", () => {
  it("Bold 폰트는 font-weight:700 로 렌더", () => {
    const content = te.encode("BT /F1 12 Tf 10 50 Td (Bold) Tj ET");
    const pdf = buildPdf([
      { num: 1, dict: "<< /Type /Catalog /Pages 2 0 R >>" },
      { num: 2, dict: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>" },
      { num: 3, dict: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>" },
      { num: 4, dict: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>" },
      { num: 5, dict: `<< /Length ${content.length} >>`, stream: content },
    ]);
    expect(previewHtml(pdf)).toContain("font-weight:700");
  });

  it("이미지보다 먼저 그린 흰 배경칠은 이미지를 가리지 않는다(그리기순서 보존)", () => {
    const rgb = zlibSync(new Uint8Array([255, 0, 0])); // 1×1 빨강
    // 흰 배경 사각형 f → 그 다음 이미지 Do (이미지가 위로 와야 함)
    const content = te.encode("1 1 1 rg 0 0 200 100 re f q 200 0 0 100 0 0 cm /Im0 Do Q");
    const pdf = buildPdf([
      { num: 1, dict: "<< /Type /Catalog /Pages 2 0 R >>" },
      { num: 2, dict: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>" },
      { num: 3, dict: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>" },
      { num: 4, dict: `<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${rgb.length} >>`, stream: rgb },
      { num: 5, dict: `<< /Length ${content.length} >>`, stream: content },
    ]);
    const html = previewHtml(pdf);
    const body = html.slice(html.indexOf("</style>"));
    // body 에서 흰 배경 SVG 가 이미지 img 보다 먼저 와야(=뒤에 깔림) 한다
    const svgIdx = body.indexOf('<svg class="pdf-vec"');
    const imgIdx = body.indexOf('<img class="pdf-img"');
    expect(svgIdx).toBeGreaterThanOrEqual(0);
    expect(imgIdx).toBeGreaterThan(svgIdx);
  });
});

describe("PDF 보이지 않는 텍스트(OCR 숨김층 Tr 3)", () => {
  it("렌더모드 3 텍스트는 그리지 않는다(스캔 OCR 레이어)", () => {
    // Tr 3 으로 'HIDDEN' 을 그린 뒤, Tr 0 으로 'VISIBLE' 을 그림
    const content = te.encode("BT /F1 12 Tf 10 50 Td 3 Tr (HIDDEN) Tj 0 Tr 10 70 Td (VISIBLE) Tj ET");
    const pdf = buildPdf([
      { num: 1, dict: "<< /Type /Catalog /Pages 2 0 R >>" },
      { num: 2, dict: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>" },
      { num: 3, dict: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>" },
      { num: 4, dict: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>" },
      { num: 5, dict: `<< /Length ${content.length} >>`, stream: content },
    ]);
    const glyphs = [...previewHtml(pdf).matchAll(/<span class="pdf-t"[^>]*>([^<]*)<\/span>/g)].map((m) => m[1]).join("");
    expect(glyphs).toBe("VISIBLE"); // HIDDEN 은 안 그려짐
  });
});

describe("PDF 연산자 디스패치(미등록 연산자가 피연산자 스택을 오염시키지 않음)", () => {
  it("'/Cs1 cs 1 0 0 sc' 처럼 cs 뒤 색은 정확히 읽힌다(흰→파랑 버그 회귀)", () => {
    // cs(미등록 연산자)가 스택에 끼면 sc 가 엉뚱한 3개를 읽어 색이 틀어졌었음.
    const content = te.encode("/Cs1 cs 1 0 0 sc 10 20 50 30 re f");
    const pdf = buildPdf([
      { num: 1, dict: "<< /Type /Catalog /Pages 2 0 R >>" },
      { num: 2, dict: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>" },
      { num: 3, dict: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 5 0 R >>" },
      { num: 5, dict: `<< /Length ${content.length} >>`, stream: content },
    ]);
    const html = previewHtml(pdf);
    expect(html).toMatch(/fill="rgb\(255,0,0\)"/); // 빨강 정확
    expect(html).not.toContain("rgb(0,0,255)"); // 파랑 오염 없음
  });
});

describe("PDF 벡터 그래픽(표 테두리·칠)", () => {
  it("채운 사각형은 SVG path(fill)로, 선은 stroke 로 렌더", () => {
    // 빨강 채움 사각형 + 검정 선
    const content = te.encode("1 0 0 rg 10 20 50 30 re f 0 0 0 RG 2 w 10 10 m 60 10 l S");
    const pdf = buildPdf([
      { num: 1, dict: "<< /Type /Catalog /Pages 2 0 R >>" },
      { num: 2, dict: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>" },
      { num: 3, dict: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 5 0 R >>" },
      { num: 5, dict: `<< /Length ${content.length} >>`, stream: content },
    ]);
    const html = previewHtml(pdf);
    expect(html).toContain('class="pdf-vec"');
    expect(html).toMatch(/<path d="M[^"]*Z" fill="rgb\(255,0,0\)"/); // 빨강 채움
    expect(html).toMatch(/stroke="rgb\(0,0,0\)"/); // 검정 선
  });
});

describe("플러그형 이미지 디코더 훅 (JPX/JBIG2)", () => {
  // /Filter /JPXDecode 이미지 1장이 깔린 PDF
  function jpxPdf(): Uint8Array {
    const jpx = new Uint8Array([0x00, 0x00, 0x00, 0x0c, 0x6a, 0x50, 0x20, 0x20]); // 더미 JP2 시그니처
    const content = te.encode("q 200 0 0 100 0 0 cm /Im0 Do Q");
    return buildPdf([
      { num: 1, dict: "<< /Type /Catalog /Pages 2 0 R >>" },
      { num: 2, dict: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>" },
      { num: 3, dict: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>" },
      { num: 4, dict: `<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /JPXDecode /Length ${jpx.length} >>`, stream: jpx },
      { num: 5, dict: `<< /Length ${content.length} >>`, stream: content },
    ]);
  }

  it("미등록이면 자리표시(placeholder)로 표시", () => {
    clearImageDecoders();
    const html = previewHtml(jpxPdf());
    expect(html).toContain('<div class="pdf-imgph"'); // 실제 자리표시 요소
    expect(html).toContain("JPXDecode");
    expect(html).not.toContain("data:image/png");
  });

  it("디코더 등록 시 픽셀(RGBA)→PNG 로 렌더", () => {
    let seen: any = null;
    registerImageDecoder("JPXDecode", (bytes, info) => {
      seen = info;
      // 2×2 빨강 RGBA
      const px = new Uint8Array(2 * 2 * 4);
      for (let i = 0; i < 4; i++) { px[i * 4] = 255; px[i * 4 + 3] = 255; }
      return { pixels: px, channels: 4, width: info.width, height: info.height };
    });
    const html = previewHtml(jpxPdf());
    clearImageDecoders();
    expect(html).toContain("data:image/png;base64,");
    expect(html).toContain('class="pdf-img"');
    expect(html).not.toContain('<div class="pdf-imgph"'); // 자리표시 없음(실제 렌더됨)
    // info 가 채워져 디코더에 전달됨
    expect(seen.filter).toBe("JPXDecode");
    expect(seen.width).toBe(2);
    expect(seen.colorSpace).toBe("DeviceRGB");
  });

  it("디코더가 data URI 를 직접 줘도 렌더", () => {
    registerImageDecoder("JPXDecode", (_b, info) => ({ uri: "data:image/jpeg;base64,/9j/AAAA", width: info.width, height: info.height }));
    const html = previewHtml(jpxPdf());
    clearImageDecoders();
    expect(html).toContain("data:image/jpeg;base64,/9j/AAAA");
    expect(html).toContain('class="pdf-img"');
  });
});

describe("PDF 암호화 안내", () => {
  it("미지원(AES/V5) 암호화는 배너로 안내", () => {
    const pdf = buildPdf([
      { num: 1, dict: "<< /Type /Catalog /Pages 2 0 R >>" },
      { num: 2, dict: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>" },
      { num: 3, dict: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] >>" },
      { num: 9, dict: "<< /Filter /Standard /V 5 /R 6 /Length 256 /O (0000000000000000000000000000000000000000000000000000000000000000) /U (0000000000000000000000000000000000000000000000000000000000000000) /P -4 >>" },
    ]);
    // trailer 에 /Encrypt 9 0 R 를 직접 끼운 변형 빌더가 필요 — 간단히 문자열 치환
    const text = new TextDecoder("latin1").decode(pdf).replace(
      "trailer << /Root 1 0 R >>",
      "trailer << /Root 1 0 R /Encrypt 9 0 R /ID [(0123456789012345)(0123456789012345)] >>",
    );
    const buf = Uint8Array.from(text, (c) => c.charCodeAt(0));
    const html = previewHtml(buf);
    expect(html).toContain("암호화");
  });
});
