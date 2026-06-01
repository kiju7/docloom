import { describe, it, expect } from "vitest";
import { readCfb } from "../src/core/cfb.js";
import { encodeDocToHtml } from "../src/encode/docToHtml.js";
import { decodeHtmlToDoc } from "../src/decode/htmlToDoc.js";
import { parseFib, parsePieceTable, readPieceText } from "../src/formats/doc-fib.js";
import { writeCfb, buildCfbModel } from "../src/core/cfb.js";

// ── 최소 .doc(Word 97-2003) CFB 빌더(doc.test.ts 와 동일 구성) ──────────────
const TEXT_FC = 0x200;

/** 비압축 UTF-16LE 한 piece 짜리 .doc 를 만든다. */
function buildDoc(text: string): Uint8Array {
  const utf16 = new Uint8Array(text.length * 2);
  {
    const dv = new DataView(utf16.buffer);
    for (let i = 0; i < text.length; i++) dv.setUint16(i * 2, text.charCodeAt(i), true);
  }
  const wd = new Uint8Array(TEXT_FC + utf16.length);
  const wdv = new DataView(wd.buffer);
  wdv.setUint16(0x0000, 0xa5ec, true);
  wdv.setUint16(0x0002, 0x00c1, true);
  wdv.setUint16(0x000a, 0x0200, true); // fWhichTblStm → 1Table
  wdv.setInt32(0x0018, TEXT_FC, true);
  wdv.setInt32(0x001c, TEXT_FC + utf16.length, true);
  wd.set(utf16, TEXT_FC);

  const n = 1;
  const lcb = (n + 1) * 4 + n * 8;
  const clx: number[] = [];
  clx.push(0x02);
  clx.push(lcb & 0xff, (lcb >> 8) & 0xff, (lcb >> 16) & 0xff, (lcb >> 24) & 0xff);
  const pushU32 = (v: number) => clx.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff);
  pushU32(0);
  pushU32(text.length);
  clx.push(0, 0);
  pushU32(TEXT_FC);
  clx.push(0, 0);

  wdv.setUint32(0x01a2, 0, true); // fcClx
  wdv.setUint32(0x01a6, clx.length, true); // lcbClx

  return writeCfb(
    buildCfbModel({
      WordDocument: wd,
      "1Table": new Uint8Array(clx),
      Data: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
    }),
  );
}

/** HTML 의 특정 data-piece 내용을 교체. */
function editPiece(html: string, id: string, newInner: string): string {
  const re = new RegExp(`(<p data-piece="${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}">)[^<]*(</p>)`);
  return html.replace(re, `$1${newInner}$2`);
}

/** WordDocument + Table 에서 piece 텍스트들을 다시 읽어온다. */
function readTexts(bytes: Uint8Array): string[] {
  const cfb = readCfb(bytes);
  const wd = cfb.streams["WordDocument"]!;
  const fib = parseFib(wd);
  const table = cfb.streams[fib.tableStreamName]!;
  const pieces = parsePieceTable(table, fib.fcClx, fib.lcbClx);
  return pieces.map((p) => readPieceText(wd, p));
}

describe("doc 왕복(길이 보존 in-place 패치)", () => {
  it("같은 길이 편집 → 텍스트 변경, WordDocument 길이·타 스트림 보존, 재파싱 정상", () => {
    const original = buildDoc("Hello World\rSecond line\r");
    const { html, manifest } = encodeDocToHtml(original);

    expect(manifest.format).toBe("doc");
    expect(manifest.container).toBe("cfb");
    expect(manifest.originalParts["__source__"]).toBeDefined();

    const srcCfb = readCfb(original);
    const srcWd = srcCfb.streams["WordDocument"]!;

    // 첫 문단 "Hello World"(11) → "Howdy Earth"(11): 같은 문자 수 → 같은 바이트 길이.
    expect("Howdy Earth".length).toBe("Hello World".length);
    const edited = editPiece(html, "0:0", "Howdy Earth");
    expect(edited).not.toBe(html);

    const out = decodeHtmlToDoc(edited, manifest);
    const outCfb = readCfb(out);
    const outWd = outCfb.streams["WordDocument"]!;

    // WordDocument 길이 불변(길이 보존 편집).
    expect(outWd.length).toBe(srcWd.length);

    // piece 텍스트가 손상 없이 재파싱되고, 편집이 반영됨.
    const texts = readTexts(out);
    expect(texts.length).toBe(1);
    expect(texts[0]).toBe("Howdy Earth\rSecond line\r");

    // 타 스트림 바이트 동일성(Data, 1Table).
    expect([...outCfb.streams["Data"]!]).toEqual([0xde, 0xad, 0xbe, 0xef]);
    expect([...outCfb.streams["1Table"]!]).toEqual([...srcCfb.streams["1Table"]!]);
  });

  it("편집 없음 → 텍스트/스트림 모두 보존", () => {
    const original = buildDoc("Alpha\rBeta\r");
    const { html, manifest } = encodeDocToHtml(original);
    const out = decodeHtmlToDoc(html, manifest);
    expect(readTexts(out)).toEqual(["Alpha\rBeta\r"]);
    expect([...readCfb(out).streams["Data"]!]).toEqual([0xde, 0xad, 0xbe, 0xef]);
  });

  it("두번째 문단만 같은 길이로 편집해도 정상", () => {
    const original = buildDoc("Alpha\rBetax\r"); // "Betax"(5)
    const { html, manifest } = encodeDocToHtml(original);
    const edited = editPiece(html, "0:1", "Gamma"); // "Gamma"(5) 동일 길이
    const out = decodeHtmlToDoc(edited, manifest);
    expect(readTexts(out)).toEqual(["Alpha\rGamma\r"]);
  });

  it("길이 변경 편집은 명확한 에러로 거부", () => {
    const original = buildDoc("Hello World\r");
    const { html, manifest } = encodeDocToHtml(original);
    const edited = editPiece(html, "0:0", "Hi"); // 11 → 2자, 길이 변경
    expect(() => decodeHtmlToDoc(edited, manifest)).toThrow(/길이가 바뀌는/);
  });
});
