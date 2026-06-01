/**
 * txt 포맷 어댑터 — 순수 텍스트 왕복 1급(encode/decode) + 미리보기.
 *
 * 서식이 없는 평문이라 CSV 처럼 "방언(줄끝 CRLF/LF·BOM)"만 보존하면 무손실 왕복이 된다.
 * 편집 채널(HTML): 한 줄 = `<p class="txt-line">`(빈 줄은 `<br>`). 셀 안 줄바꿈 같은 개념은 없다.
 * 복원 키트(Manifest): 줄끝·BOM 을 native 에 담고 format="txt"/container="text" 로 표시.
 *
 * 왕복 정밀도: **값 무손실**(줄 내용·줄 수·줄끝·BOM 보존). 혼합 줄끝은 지배적인 한 종류로 정규화.
 */
import type { FormatAdapter, EncodeResultBase } from "../core/format.js";
import type { Manifest } from "../model/manifest.js";
import { toPreviewHtml, type PreviewOptions } from "../preview/preview.js";
import { parse } from "node-html-parser";

const td = new TextDecoder("utf-8", { ignoreBOM: true });
const te = new TextEncoder();
const UTF8_BOM = "﻿";

interface TextDialect {
  eol: "\r\n" | "\n";
  bom: boolean;
}

function sniff(text: string): { dialect: TextDialect; body: string } {
  const bom = text.startsWith(UTF8_BOM);
  const body = bom ? text.slice(UTF8_BOM.length) : text;
  // 첫 줄끝이 CRLF 면 CRLF, 아니면 LF.
  const firstNl = body.indexOf("\n");
  const crlf = firstNl > 0 && body[firstNl - 1] === "\r";
  return { dialect: { eol: crlf ? "\r\n" : "\n", bom }, body };
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * 본문 → 한 줄 = `<p class="txt-line">`. 빈 줄은 빈 `<p>`(텍스트 ""). `<br>` 를 쓰면
 * decode 의 br→개행 변환과 줄 join 이 겹쳐 빈 줄이 두 줄로 불어나므로 쓰지 않는다.
 * (빈 문단의 시각적 높이는 미리보기 CSS 의 min-height 로 확보.)
 */
function linesToHtml(body: string): string {
  // \r\n / \r / \n 모두 줄 경계로 본다(왕복 시 native.eol 로 통일됨).
  const lines = body.split(/\r\n|\r|\n/);
  return lines.map((l) => `<p class="txt-line">${esc(l)}</p>`).join("\n");
}

export function txtEncode(bytes: Uint8Array): EncodeResultBase {
  const text = td.decode(bytes);
  const { dialect, body } = sniff(text);
  const manifest: Manifest = {
    version: 1,
    format: "txt",
    container: "text",
    originalParts: { "source.txt": bytes },
    native: { eol: dialect.eol === "\r\n" ? "crlf" : "lf", bom: dialect.bom ? "1" : "0" },
    frozen: {},
    props: {},
    paletteId: "txt",
  };
  return { html: linesToHtml(body), manifest };
}

/** 편집된 HTML 의 줄 블록들 → 본문 텍스트. `<br>` 와 블록 경계를 줄바꿈으로 본다. */
function htmlToBody(html: string, eol: "\r\n" | "\n"): string {
  const root = parse(html);
  let blocks = root.querySelectorAll("p.txt-line");
  if (blocks.length === 0) blocks = root.querySelectorAll("p, div");
  let lines: string[];
  if (blocks.length === 0) {
    // 블록이 없으면 통째 텍스트(엔티티 복원).
    lines = [root.text];
  } else {
    lines = blocks.map((el) => {
      // 줄 안의 <br> 도 줄바꿈으로(편집 중 추가될 수 있음).
      const inner = el.innerHTML.replace(/<br\s*\/?>(?:\r?\n)?/gi, "\n");
      return parse(`<x>${inner}</x>`).text;
    });
  }
  // 블록/내부 \n 모두 통일된 줄끝으로.
  return lines.join("\n").replace(/\r\n|\r|\n/g, eol);
}

export function txtDecode(html: string, manifest: Manifest): Uint8Array {
  const nv = manifest.native ?? {};
  const eol: "\r\n" | "\n" = nv.eol === "crlf" ? "\r\n" : "\n";
  const bom = nv.bom === "1";
  const body = htmlToBody(html, eol);
  return te.encode((bom ? UTF8_BOM : "") + body);
}

export function txtToPreviewHtml(bytes: Uint8Array, opts: PreviewOptions = {}): string {
  const text = td.decode(bytes);
  const { body } = sniff(text);
  const css = `
  .docloom-doc.txt-doc { white-space: pre-wrap; word-break: break-word; font-family:
    "SFMono-Regular", "Menlo", "Consolas", "D2Coding", "Malgun Gothic", monospace; font-size: 13px; line-height: 1.6; }
  `;
  const doc = `<div class="docloom-doc txt-doc">${esc(body)}</div>`;
  return toPreviewHtml(doc, { ...opts, css: (opts.css ?? "") + css });
}

export const txtAdapter: FormatAdapter = {
  id: "txt",
  label: "순수 텍스트 (.txt)",
  supportsRoundTrip: true,
  detect(parts) {
    // 평문이라 zip part 로는 판별하지 않는다(registry 가 컨테이너+힌트로 라우팅).
    return Object.keys(parts).length === 0;
  },
  encode(bytes) {
    return txtEncode(bytes);
  },
  decode(html, manifest) {
    return txtDecode(html, manifest);
  },
  toPreviewHtml(bytes, opts) {
    return txtToPreviewHtml(bytes, (opts ?? {}) as PreviewOptions);
  },
};
