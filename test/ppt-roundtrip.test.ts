import { describe, it, expect } from "vitest";
import { writeCfb, buildCfbModel, readCfb } from "../src/core/cfb.js";
import { encodePptToHtml } from "../src/encode/pptToHtml.js";
import { decodeHtmlToPpt } from "../src/decode/htmlToPpt.js";
import { collectTextAtoms } from "../src/formats/ppt-records.js";

// ── PPT 레코드 빌더(ppt.test.ts 의 CFB 구성 재사용) ──────────────────────────

/** 레코드 헤더(8B) + body. verInst 하위 4bit 0xF 면 컨테이너. */
function rec(verInst: number, recType: number, body: number[]): number[] {
  const len = body.length;
  return [
    verInst & 0xff, (verInst >> 8) & 0xff,
    recType & 0xff, (recType >> 8) & 0xff,
    len & 0xff, (len >> 8) & 0xff, (len >> 16) & 0xff, (len >> 24) & 0xff,
    ...body,
  ];
}
function textChars(s: string): number[] {
  const body: number[] = [];
  for (const c of s) {
    const code = c.charCodeAt(0);
    body.push(code & 0xff, (code >> 8) & 0xff);
  }
  return rec(0x0000, 0x0fa0, body);
}
function textBytes(s: string): number[] {
  return rec(0x0000, 0x0fa8, [...s].map((c) => c.charCodeAt(0) & 0xff));
}
/** StyleTextPropAtom(0x0FA1) 대용: 서식 레코드가 건드려지지 않음을 검증하는 마커. */
function styleProp(marker: number[]): number[] {
  return rec(0x0000, 0x0fa1, marker);
}
function slide(children: number[]): number[] {
  return rec(0x000f, 0x03ee, children);
}

/** 두 텍스트 atom + 서식 레코드를 가진 PowerPoint Document 스트림 + 부가 스트림. */
function buildPpt(): Uint8Array {
  const doc = [
    ...slide([
      ...textBytes("Hello World"),
      ...styleProp([0xaa, 0xbb, 0xcc, 0xdd]), // 서식: 그대로 보존되어야 함
      ...textChars("제목 텍스트"),
    ]),
    ...slide([...textBytes("Body line two")]),
  ];
  return writeCfb(
    buildCfbModel({
      "PowerPoint Document": new Uint8Array(doc),
      "Current User": new Uint8Array([0x20, 0, 0, 0, 0xf3, 0xd1, 0xc4, 0x5e, 0, 0, 0, 0]),
      Pictures: new Uint8Array([1, 2, 3, 4, 5]),
    }),
  );
}

/** HTML 의 특정 data-atom 내용을 교체. */
function editAtom(html: string, id: string, newInner: string): string {
  const re = new RegExp(`(<p data-atom="${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}">)[^<]*(</p>)`);
  return html.replace(re, `$1${newInner}$2`);
}

describe("ppt 왕복(전략 A: 길이 보존 in-place)", () => {
  it("같은 길이 편집 → 텍스트 변경, 서식/타 스트림/오프셋 정합 보존", () => {
    const original = buildPpt();
    const { html, manifest } = encodePptToHtml(original);

    expect(manifest.format).toBe("ppt");
    expect(manifest.container).toBe("cfb");
    expect(manifest.originalParts["__source__"]).toBeDefined();

    // atom id 수집(원본 스트림에서).
    const srcCfb = readCfb(original);
    const docBytes = srcCfb.streams["PowerPoint Document"]!;
    const atoms = collectTextAtoms(docBytes);
    expect(atoms.length).toBe(3);
    const helloId = `${atoms[0]!.headerOffset}:${atoms[0]!.recType}:0`;

    // "Hello World"(11자) → "HELLO WORLD!"는 12자라 길이 변경. 같은 길이로: "Howdy Earth"(11자).
    expect("Howdy Earth".length).toBe("Hello World".length);
    const edited = editAtom(html, helloId, "Howdy Earth");
    expect(edited).not.toBe(html);

    const out = decodeHtmlToPpt(edited, manifest);

    // 재-readCfb + 재-walk.
    const outCfb = readCfb(out);
    const outDoc = outCfb.streams["PowerPoint Document"]!;

    // 스트림 길이 불변(길이 보존 편집).
    expect(outDoc.length).toBe(docBytes.length);

    const outAtoms = collectTextAtoms(outDoc);
    // 레코드 트리가 그대로 파싱됨(오프셋 손상 없음): 동일 개수·동일 오프셋.
    expect(outAtoms.length).toBe(atoms.length);
    for (let i = 0; i < atoms.length; i++) {
      expect(outAtoms[i]!.headerOffset).toBe(atoms[i]!.headerOffset);
      expect(outAtoms[i]!.recType).toBe(atoms[i]!.recType);
      expect(outAtoms[i]!.bodyLength).toBe(atoms[i]!.bodyLength);
    }

    // 편집된 atom 텍스트 변경.
    expect(outAtoms[0]!.text).toBe("Howdy Earth");
    // 미편집 atom 그대로.
    expect(outAtoms[1]!.text).toBe("제목 텍스트");
    expect(outAtoms[2]!.text).toBe("Body line two");

    // 서식 레코드(StyleTextPropAtom 0x0FA1) 바이트가 그대로인지 확인.
    const findStyle = (b: Uint8Array): number[] => {
      const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
      const found: number[] = [];
      const walk = (s: number, e: number): void => {
        let p = s;
        while (p + 8 <= e) {
          const vi = dv.getUint16(p, true);
          const rt = dv.getUint16(p + 2, true);
          const rl = dv.getUint32(p + 4, true);
          const bs = p + 8;
          const be = bs + rl;
          if (be > e) break;
          if ((vi & 0xf) === 0xf) walk(bs, be);
          else if (rt === 0x0fa1) for (let q = bs; q < be; q++) found.push(b[q]!);
          p = be;
        }
      };
      walk(0, b.length);
      return found;
    };
    expect(findStyle(outDoc)).toEqual([0xaa, 0xbb, 0xcc, 0xdd]);

    // 타 스트림 바이트 동일성.
    expect([...outCfb.streams["Pictures"]!]).toEqual([1, 2, 3, 4, 5]);
    expect([...outCfb.streams["Current User"]!]).toEqual([...srcCfb.streams["Current User"]!]);
  });

  it("편집 없음 → 텍스트/스트림 모두 보존", () => {
    const original = buildPpt();
    const { html, manifest } = encodePptToHtml(original);
    const out = decodeHtmlToPpt(html, manifest);
    const outCfb = readCfb(out);
    const atoms = collectTextAtoms(outCfb.streams["PowerPoint Document"]!);
    expect(atoms.map((a) => a.text)).toEqual(["Hello World", "제목 텍스트", "Body line two"]);
    expect([...outCfb.streams["Pictures"]!]).toEqual([1, 2, 3, 4, 5]);
  });

  it("길이 변경 편집은 기본적으로 거부(전략 B 옵트인 필요)", () => {
    const original = buildPpt();
    const { html, manifest } = encodePptToHtml(original);
    const atoms = collectTextAtoms(readCfb(original).streams["PowerPoint Document"]!);
    const helloId = `${atoms[0]!.headerOffset}:${atoms[0]!.recType}:0`;
    const edited = editAtom(html, helloId, "Hi"); // 11자 → 2자, 길이 변경
    expect(() => decodeHtmlToPpt(edited, manifest)).toThrow(/persist-offset|길이/);
  });

  it("전략 B(allowRelayout): 길이 변경 후에도 레코드 트리·오프셋 정합 재파싱", () => {
    const original = buildPpt();
    const { html, manifest } = encodePptToHtml(original);
    const srcCfb = readCfb(original);
    const docBytes = srcCfb.streams["PowerPoint Document"]!;
    const atoms = collectTextAtoms(docBytes);
    const helloId = `${atoms[0]!.headerOffset}:${atoms[0]!.recType}:0`;

    // "Hello World"(11) → "Hi there everyone!!"(19) : +8 바이트.
    const newText = "Hi there everyone!!";
    const edited = editAtom(html, helloId, newText);
    const out = decodeHtmlToPpt(edited, manifest, { allowRelayout: true });

    const outCfb = readCfb(out);
    const outDoc = outCfb.streams["PowerPoint Document"]!;
    const outAtoms = collectTextAtoms(outDoc);

    // 레코드 트리가 손상 없이 재파싱됨: atom 개수 동일, 텍스트 반영.
    expect(outAtoms.length).toBe(atoms.length);
    expect(outAtoms[0]!.text).toBe(newText);
    expect(outAtoms[1]!.text).toBe("제목 텍스트");
    expect(outAtoms[2]!.text).toBe("Body line two");

    const delta = newText.length - "Hello World".length;
    // 스트림 길이가 delta 만큼 늘었다(+8).
    expect(outDoc.length).toBe(docBytes.length + delta);

    // 첫 Slide 컨테이너(0x03EE)의 recLen 이 정확히 delta 만큼 커졌는지 직접 확인.
    const recLenOf = (b: Uint8Array, type: number): number => {
      const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
      for (let p = 0; p + 8 <= b.length; ) {
        const rt = dv.getUint16(p + 2, true);
        const rl = dv.getUint32(p + 4, true);
        if (rt === type) return rl;
        const isC = (dv.getUint16(p, true) & 0xf) === 0xf;
        p = isC ? p + 8 : p + 8 + rl;
      }
      return -1;
    };
    expect(recLenOf(outDoc, 0x03ee)).toBe(recLenOf(docBytes, 0x03ee) + delta);

    // 서식 레코드 보존.
    expect([...outCfb.streams["Pictures"]!]).toEqual([1, 2, 3, 4, 5]);
  });
});
