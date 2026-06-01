/**
 * csv 포맷 어댑터 — 왕복 1급(encode/decode) + 미리보기.
 *
 * CSV 는 서식이 없는 평문 표라 docx 처럼 "원본 part 보존"이 필요 없다. 대신 **방언(dialect)**
 * — 구분자(, ; \t |), 줄끝(CRLF/LF), BOM 유무 — 만 보존하면 데이터 무손실 왕복이 된다.
 *
 * 편집 채널(HTML): <table class="csv-grid"> 의 <td> 가 곧 셀. 셀 안 줄바꿈은 <br>.
 * 복원 키트(Manifest): 원본 방언을 native 에 담고, format="csv"/container="text" 로 표시.
 *
 * 왕복 정밀도: **값 무손실**(셀 텍스트가 정확히 보존)을 보장한다. 불필요했던 따옴표를
 * 다시 붙이는지 같은 기계적 차이는 정규화될 수 있다(Excel 도 동일) — 데이터는 안 변한다.
 */
import type { FormatAdapter, EncodeResultBase } from "../core/format.js";
import type { Manifest } from "../model/manifest.js";
import { toPreviewHtml, type PreviewOptions } from "../preview/preview.js";
import { parse, type HTMLElement } from "node-html-parser";

// ignoreBOM: 선행 U+FEFF 를 벗기지 않고 남겨 둬야 방언 감지가 BOM 을 본다(기본 디코더는 벗겨냄).
const td = new TextDecoder("utf-8", { ignoreBOM: true });
const te = new TextEncoder();

/** CSV 방언: 재직렬화가 원본의 기계적 관습을 따르도록 보존한다. */
export interface CsvDialect {
  delimiter: string; // "," | ";" | "\t" | "|"
  eol: "\r\n" | "\n";
  bom: boolean;
  quote: '"';
}

const DELIM_CANDIDATES = [",", ";", "\t", "|"];
const UTF8_BOM = "﻿";

/** 첫 줄(따옴표 밖)에서 후보 구분자 빈도를 세어 가장 흔한 것을 고른다. */
function sniffDelimiter(text: string): string {
  let line = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && (ch === "\n" || ch === "\r")) break;
    line += ch;
  }
  let best = ",";
  let bestN = -1;
  for (const d of DELIM_CANDIDATES) {
    const n = line.split(d).length - 1;
    if (n > bestN) {
      bestN = n;
      best = d;
    }
  }
  return best;
}

/** 원본 텍스트에서 방언을 추출. */
export function sniffDialect(text: string): CsvDialect {
  const bom = text.startsWith(UTF8_BOM);
  const body = bom ? text.slice(UTF8_BOM.length) : text;
  // 첫 줄끝이 \r\n 이면 CRLF, 아니면 LF (단독 \r 는 드물어 LF 로 정규화)
  const crlf = /\r\n/.test(body.slice(0, body.indexOf("\n") + 1 || body.length));
  return { delimiter: sniffDelimiter(body), eol: crlf ? "\r\n" : "\n", bom, quote: '"' };
}

/**
 * RFC4180 파서. 따옴표 필드(구분자·줄바꿈·이중따옴표 포함) 처리.
 * 따옴표는 필드 시작에서만 여는 것으로 본다(Excel 관습). 줄끝은 \r\n/\n/\r 모두 허용.
 */
export function parseCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let fieldStart = true; // 현재 필드에 아직 문자를 안 넣었는가
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && fieldStart) {
      inQuotes = true;
      fieldStart = false;
    } else if (ch === delimiter) {
      row.push(field);
      field = "";
      fieldStart = true;
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++; // CRLF 한 번에
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      fieldStart = true;
    } else {
      field += ch;
      fieldStart = false;
    }
  }
  // 마지막 필드/행 (파일이 줄끝 없이 끝난 경우)
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** 필드를 RFC4180 규칙으로 직렬화(필요할 때만 따옴표). */
function serializeField(v: string, delimiter: string): string {
  if (v.includes('"') || v.includes(delimiter) || v.includes("\n") || v.includes("\r")) {
    return '"' + v.replace(/"/g, '""') + '"';
  }
  return v;
}

/** 행 배열 + 방언 → CSV 바이트. */
export function serializeCsv(rows: string[][], d: CsvDialect): Uint8Array {
  const body = rows.map((r) => r.map((c) => serializeField(c, d.delimiter)).join(d.delimiter)).join(d.eol);
  return te.encode((d.bom ? UTF8_BOM : "") + body);
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 셀 텍스트 → 편집용 HTML(셀 안 줄바꿈은 <br>). */
function cellToHtml(v: string): string {
  return esc(v).replace(/\r\n|\r|\n/g, "<br>");
}

/** 편집용 <td>.innerHTML → 셀 텍스트(<br>→\n, 엔티티 복원). */
function htmlCellToText(el: HTMLElement): string {
  // <br> 를 개행으로 바꾼 뒤 텍스트 추출(node-html-parser 가 엔티티를 디코드해 준다).
  const html = el.innerHTML.replace(/<br\s*\/?>(?:\r?\n)?/gi, "\n");
  return parse(`<x>${html}</x>`).text;
}

/** 행 배열 + 방언 → 편집/왕복용 HTML 표. data-* 로 방언을 자기기술. */
function rowsToHtml(rows: string[][], d: CsvDialect): string {
  const trs = rows
    .map((r) => `<tr>${r.map((c) => `<td>${cellToHtml(c)}</td>`).join("")}</tr>`)
    .join("\n");
  const delimAttr = d.delimiter === "\t" ? "\\t" : d.delimiter;
  return (
    `<table class="csv-grid" data-delim="${esc(delimAttr)}" data-eol="${d.eol === "\r\n" ? "crlf" : "lf"}"` +
    ` data-bom="${d.bom ? 1 : 0}">\n<tbody>\n${trs}\n</tbody>\n</table>`
  );
}

export function csvEncode(bytes: Uint8Array): EncodeResultBase {
  const text = td.decode(bytes);
  const dialect = sniffDialect(text);
  const body = dialect.bom ? text.slice(UTF8_BOM.length) : text;
  const rows = parseCsv(body, dialect.delimiter);
  const manifest: Manifest = {
    version: 1,
    format: "csv",
    container: "text",
    // CSV 는 본문에서 전부 재생성하므로 원본 보존이 필수는 아니지만, manifest 계약상
    // 원본 바이트를 그대로 담아 둔다(복구 안전망).
    originalParts: { "source.csv": bytes },
    native: {
      delimiter: dialect.delimiter,
      eol: dialect.eol === "\r\n" ? "crlf" : "lf",
      bom: dialect.bom ? "1" : "0",
    },
    frozen: {},
    props: {},
    paletteId: "csv",
  };
  return { html: rowsToHtml(rows, dialect), manifest };
}

/** Manifest.native → 방언(없으면 안전한 기본값). */
function dialectFromManifest(m: Manifest): CsvDialect {
  const nv = m.native ?? {};
  const delim = nv.delimiter === "\\t" ? "\t" : nv.delimiter ?? ",";
  return { delimiter: delim, eol: nv.eol === "lf" ? "\n" : "\r\n", bom: nv.bom === "1", quote: '"' };
}

export function csvDecode(html: string, manifest: Manifest): Uint8Array {
  const dialect = dialectFromManifest(manifest);
  const root = parse(html);
  const table = root.querySelector("table.csv-grid") ?? root.querySelector("table");
  if (!table) throw new Error("[docloom] CSV decode: <table> 을 찾을 수 없습니다.");
  const rows: string[][] = [];
  for (const tr of table.querySelectorAll("tr")) {
    const cells = tr.querySelectorAll("td, th");
    rows.push(cells.map(htmlCellToText));
  }
  return serializeCsv(rows, dialect);
}

export function csvToPreviewHtml(bytes: Uint8Array, opts: PreviewOptions = {}): string {
  const text = td.decode(bytes);
  const dialect = sniffDialect(text);
  const body = dialect.bom ? text.slice(UTF8_BOM.length) : text;
  const rows = parseCsv(body, dialect.delimiter);
  const cols = rows.reduce((m, r) => Math.max(m, r.length), 0);

  // 행번호 머리열 + 첫 행을 옅게 강조(머리행 추정 — 데이터는 그대로).
  const bodyRows = rows
    .map((r, i) => {
      let tds = `<th class="csv-rowh">${i + 1}</th>`;
      for (let c = 0; c < cols; c++) tds += `<td>${cellToHtml(r[c] ?? "")}</td>`;
      return `<tr class="${i === 0 ? "csv-head" : ""}">${tds}</tr>`;
    })
    .join("");

  const css = `
  body { padding: 24px; }
  .csv-scroll { overflow:auto; max-width:100%; border:1px solid #c9ccd1; border-radius:6px; background:#fff; }
  .csv-grid { border-collapse: collapse; font-size: 12px; color:#1a1a1a; }
  .csv-grid td, .csv-grid th { border:1px solid #e1e3e8; padding:3px 8px; vertical-align:top; white-space:pre-wrap; }
  .csv-rowh { background:#f3f4f6; color:#6b7280; font-weight:600; text-align:center; font-size:11px; }
  .csv-head td { background:#f7f9fc; font-weight:600; }
  `;
  const grid = `<div class="csv-scroll"><table class="csv-grid"><tbody>${bodyRows}</tbody></table></div>`;
  return toPreviewHtml(grid, { ...opts, css: (opts.css ? opts.css : "") + css });
}

export const csvAdapter: FormatAdapter = {
  id: "csv",
  label: "CSV 표 (.csv)",
  supportsRoundTrip: true,
  detect(parts) {
    // CSV 는 zip part 가 아니라 평문이므로 part 맵으로는 판별하지 않는다(registry 가 컨테이너로 라우팅).
    return Object.keys(parts).length === 0;
  },
  encode(bytes) {
    return csvEncode(bytes);
  },
  decode(html, manifest) {
    return csvDecode(html, manifest);
  },
  toPreviewHtml(bytes, opts) {
    return csvToPreviewHtml(bytes, (opts ?? {}) as PreviewOptions);
  },
};
