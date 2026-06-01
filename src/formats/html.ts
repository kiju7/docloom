/**
 * html 포맷 어댑터 — 웹 문서 왕복 1급(encode/decode) + 미리보기.
 *
 * 편집 대상이 곧 HTML 이라 변환이 거의 없다. 핵심은 **셸 보존**:
 *   - encode : `<body>` 안쪽만 편집 채널(html)로 내보낸다.
 *   - decode : 원본의 `<body>` 바깥(doctype·`<head>`·`<html>` 속성 등)은 그대로 두고,
 *              편집된 본문만 다시 끼워 넣는다 → `<head>` 의 CSS/메타가 깨지지 않는다.
 *   - 미리보기 : 완결 문서면 원본을 그대로 보여 충실도가 최고(자기 CSS 포함).
 *
 * `<body>` 가 없는 조각(fragment)이면 전체를 본문으로 보고 그대로 왕복한다.
 */
import type { FormatAdapter, EncodeResultBase } from "../core/format.js";
import type { Manifest } from "../model/manifest.js";
import { toPreviewHtml, type PreviewOptions } from "../preview/preview.js";

const td = new TextDecoder("utf-8", { ignoreBOM: true });
const te = new TextEncoder();
const UTF8_BOM = "﻿";

// 셸 분리: (prefix … <body …>)(본문)(</body> … tail). 그리디라 마지막 body 경계를 잡는다.
const BODY_RE = /^([\s\S]*<body\b[^>]*>)([\s\S]*)(<\/body>[\s\S]*)$/i;

interface HtmlShell {
  prefix: string;
  body: string;
  suffix: string;
  /** 완결 문서(<body> 또는 <html> 보유)인가. */
  full: boolean;
}

function splitShell(text: string): HtmlShell {
  const m = BODY_RE.exec(text);
  if (m) return { prefix: m[1]!, body: m[2]!, suffix: m[3]!, full: true };
  const full = /<html[\s>]/i.test(text);
  return { prefix: "", body: text, suffix: "", full };
}

export function htmlEncode(bytes: Uint8Array): EncodeResultBase {
  const raw = td.decode(bytes);
  const bom = raw.startsWith(UTF8_BOM);
  const text = bom ? raw.slice(UTF8_BOM.length) : raw;
  const shell = splitShell(text);
  const manifest: Manifest = {
    version: 1,
    format: "html",
    container: "text",
    // 셸(헤드/doctype/html 속성)은 원본 바이트에서 decode 때 다시 분리해 복원한다.
    originalParts: { "source.html": bytes },
    native: { bom: bom ? "1" : "0", full: shell.full ? "1" : "0" },
    frozen: {},
    props: {},
    paletteId: "html",
  };
  return { html: shell.body.trim() ? shell.body : "", manifest };
}

export function htmlDecode(html: string, manifest: Manifest): Uint8Array {
  const nv = manifest.native ?? {};
  const bom = nv.bom === "1";
  const src = manifest.originalParts?.["source.html"];
  let out: string;
  if (src && src.length) {
    const raw = td.decode(src);
    const text = raw.startsWith(UTF8_BOM) ? raw.slice(UTF8_BOM.length) : raw;
    const shell = splitShell(text);
    out = shell.full ? shell.prefix + html + shell.suffix : html;
  } else {
    // 원본 부재(직접 호출) — 편집 본문만.
    out = html;
  }
  return te.encode((bom ? UTF8_BOM : "") + out);
}

export function htmlToPreviewHtml(bytes: Uint8Array, opts: PreviewOptions = {}): string {
  const raw = td.decode(bytes);
  const text = raw.startsWith(UTF8_BOM) ? raw.slice(UTF8_BOM.length) : raw;
  const shell = splitShell(text);
  // 완결 문서는 원본 그대로가 가장 충실(자체 <head> CSS 포함).
  if (shell.full && /<html[\s>]/i.test(text)) return text;
  // 조각이면 docloom 미리보기 셸에 본문을 담는다.
  return toPreviewHtml(`<div class="docloom-doc">${shell.body}</div>`, opts);
}

export const htmlAdapter: FormatAdapter = {
  id: "html",
  label: "웹 문서 (.html)",
  supportsRoundTrip: true,
  detect(parts) {
    return Object.keys(parts).length === 0;
  },
  encode(bytes) {
    return htmlEncode(bytes);
  },
  decode(html, manifest) {
    return htmlDecode(html, manifest);
  },
  toPreviewHtml(bytes, opts) {
    return htmlToPreviewHtml(bytes, (opts ?? {}) as PreviewOptions);
  },
};
