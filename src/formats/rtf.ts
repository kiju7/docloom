/**
 * rtf 포맷 어댑터 — RTF(Rich Text Format) ↔ 편집 HTML 왕복.
 *
 * RTF 는 평문(매직 `{\rtf`)이지만 본문이 제어워드·헥스 이스케이프로 뒤섞여 있어 LLM 이
 * 그대로 읽고 고치기 어렵다. 그래서:
 *   - encode: RTF → **깨끗한 편집 HTML**(헥스/유니코드 디코드, 문단·굵게/기울임/밑줄).
 *     각 텍스트 런에 `data-rid` 를 달아 복원 시 원본 토큰과 매칭한다.
 *   - decode: 편집 HTML → RTF. **구조 보존 + 텍스트 런만 패치** —
 *     원본 토큰 스트림을 그대로 두고, 내용이 바뀐 런의 문자 토큰만 새로 인코딩(`\uN`
 *     유니코드 이스케이프, 코드페이지 무관)해 끼워 넣는다. 안 바뀐 런·서식·폰트·색은 원본 그대로.
 *
 * 왕복 정밀도: **편집 없으면 바이트 동일**(토큰 raw 를 그대로 이어붙임). 텍스트만 바꾸면
 * 그 런만 재인코딩되고 나머지 전부 보존. (HWP/doc v1 과 같은 "텍스트 내용" 범위 — 문단
 * 추가/삭제·서식 토글은 범위 밖.)
 */
import type { FormatAdapter, EncodeResultBase, PreviewOptionsBase } from "../core/format.js";
import type { Manifest } from "../model/manifest.js";
import { toPreviewHtml } from "../preview/preview.js";
import { parse } from "node-html-parser";

// ── latin1 바이트 ↔ 문자열(바이트당 1문자, 무손실) ──────────────────────────
function bytesToLatin1(b: Uint8Array): string {
  let s = "";
  // 청크로 끊어 스택 한계 회피.
  for (let i = 0; i < b.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000) as unknown as number[]);
  }
  return s;
}
function latin1ToBytes(s: string): Uint8Array {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
  return b;
}

// ── 코드페이지 → TextDecoder 라벨 ──────────────────────────────────────────
const CP_LABEL: Record<number, string> = {
  1252: "windows-1252", 1250: "windows-1250", 1251: "windows-1251", 1253: "windows-1253",
  1254: "windows-1254", 1255: "windows-1255", 1256: "windows-1256", 1257: "windows-1257",
  1258: "windows-1258", 874: "windows-874", 932: "shift_jis", 936: "gbk", 949: "euc-kr",
  950: "big5", 65001: "utf-8", 10000: "macintosh",
};
// \fcharsetN → 코드페이지(주요값만).
const CHARSET_CP: Record<number, number> = {
  0: 1252, 77: 10000, 128: 932, 129: 949, 130: 1361, 134: 936, 136: 950, 161: 1253,
  162: 1254, 163: 1258, 177: 1255, 178: 1256, 186: 1257, 204: 1251, 222: 874, 238: 1250,
};
const decoderCache = new Map<number, InstanceType<typeof TextDecoder>>();
function decoderFor(cp: number): InstanceType<typeof TextDecoder> {
  let d = decoderCache.get(cp);
  if (!d) {
    const label = CP_LABEL[cp] ?? "windows-1252";
    try { d = new TextDecoder(label); } catch { d = new TextDecoder("windows-1252"); }
    decoderCache.set(cp, d);
  }
  return d;
}

// ── 토큰 ────────────────────────────────────────────────────────────────────
type Tok =
  | { t: "open"; raw: string }   // {
  | { t: "close"; raw: string }  // }
  | { t: "ctrl"; word: string; param: number | null; raw: string } // \word, \wordN
  | { t: "hex"; byte: number; raw: string }  // \'XX
  | { t: "uni"; cp: number; raw: string }    // \uN
  | { t: "text"; text: string; raw: string } // 리터럴(고바이트 포함) — text 는 표시문자, raw 는 원본
  | { t: "raw"; raw: string };               // CR/LF 등 무의미 바이트(문자 기여 없음)

/** RTF(latin1 문자열)를 토큰 배열로. tokens.map(raw).join('') === 입력 보장. */
function tokenize(s: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i]!;
    if (c === "{") { toks.push({ t: "open", raw: "{" }); i++; continue; }
    if (c === "}") { toks.push({ t: "close", raw: "}" }); i++; continue; }
    if (c === "\\") {
      const next = s[i + 1];
      // 이스케이프 리터럴 \\ \{ \}
      if (next === "\\" || next === "{" || next === "}") {
        toks.push({ t: "text", text: next, raw: "\\" + next });
        i += 2; continue;
      }
      // 헥스 \'XX
      if (next === "'") {
        const hex = s.slice(i + 2, i + 4);
        const byte = parseInt(hex, 16);
        toks.push({ t: "hex", byte: isNaN(byte) ? 0 : byte, raw: "\\'" + hex });
        i += 4; continue;
      }
      // 제어워드 \word, \word-?N, 또는 제어기호 \* \~ \- 등
      const m = /^\\([a-zA-Z]+)(-?\d+)? ?/.exec(s.slice(i));
      if (m) {
        const word = m[1]!;
        const param = m[2] != null ? parseInt(m[2], 10) : null;
        if (word === "u" && param != null) {
          toks.push({ t: "uni", cp: param < 0 ? param + 65536 : param, raw: m[0] });
        } else {
          toks.push({ t: "ctrl", word, param, raw: m[0] });
        }
        i += m[0].length; continue;
      }
      // 제어기호(\* \~ \_ \- \: \| 등): 백슬래시 + 1문자
      const sym = next ?? "";
      toks.push({ t: "ctrl", word: sym, param: null, raw: "\\" + sym });
      i += 2; continue;
    }
    // 일반 바이트: CR/LF 는 무의미(raw 보존, 문자기여 없음), 그 외는 텍스트.
    if (c === "\r" || c === "\n") { toks.push({ t: "raw", raw: c }); i++; continue; }
    // 연속 리터럴 텍스트를 한 토큰으로 모은다(\ { } CR LF 전까지).
    let j = i;
    while (j < n && !"\\{}\r\n".includes(s[j]!)) j++;
    const text = s.slice(i, j);
    toks.push({ t: "text", text, raw: text });
    i = j;
  }
  return toks;
}

// ── 인코딩(encode): 토큰 → 편집 HTML + 런 매핑 ───────────────────────────────
/** 한 런 = 같은 서식(b/i/u) 아래 연속 문자 토큰 묶음. tokIdx 범위로 원본과 매칭. */
interface RunMap {
  rid: string;
  start: number; // 첫 문자토큰 인덱스
  end: number;   // 마지막 문자토큰 인덱스(포함)
  text: string;  // 디코드된 표시 텍스트
}

// 본문으로 렌더하지 않는 목적지 제어워드(그룹 통째 건너뜀).
const SKIP_DEST = new Set([
  "fonttbl", "filetbl", "colortbl", "stylesheet", "listtable", "listoverridetable",
  "revtbl", "rsidtbl", "info", "pict", "object", "fldinst", "themedata",
  "colorschememapping", "datastore", "latentstyles", "generator", "xmlnstbl",
  "wgrffmtfilter", "mmathPr", "wbitmap",
]);

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

interface EncodeState {
  cp: number;           // 현재 유효 코드페이지
  ansicpg: number;      // \ansicpg 기본값
  fontCp: Map<number, number>; // \fN → 코드페이지(\fcharset 에서)
  bold: boolean; italic: boolean; under: boolean;
}

function rtfToHtmlAndMap(toks: Tok[]): { html: string; runs: RunMap[] } {
  // 그룹 스택: 각 그룹이 "건너뛰는 목적지"인지.
  const skipStack: boolean[] = [];
  let skipping = false;
  let groupDepth = 0;
  // \fcharset 수집을 위해 fonttbl 안의 현재 폰트 번호 추적(그룹 깊이로 범위 판정).
  let fontTblDepth = -1;
  let curFontNum: number | null = null;
  const inFontTbl = () => fontTblDepth >= 0 && groupDepth >= fontTblDepth;

  const st: EncodeState = {
    cp: 1252, ansicpg: 1252, fontCp: new Map(),
    bold: false, italic: false, under: false,
  };
  // 서식 스택(그룹 단위 저장/복원).
  const fmtStack: { bold: boolean; italic: boolean; under: boolean; cp: number }[] = [];

  const paras: string[] = []; // 완성된 문단 HTML
  let curParts: string[] = []; // 현재 문단의 인라인 조각
  const runs: RunMap[] = [];
  let ridSeq = 0;

  // 현재 누적 중인 런.
  let runBytes: number[] = [];
  let runByteCp = st.cp;
  let runStart = -1;
  let runEnd = -1;
  let runText = "";
  let runFmt = { bold: false, italic: false, under: false };

  function decodeBytes(bytes: number[], cp: number): string {
    if (!bytes.length) return "";
    return decoderFor(cp).decode(new Uint8Array(bytes));
  }
  function flushBytes() {
    if (runBytes.length) {
      runText += decodeBytes(runBytes, runByteCp);
      runBytes = [];
    }
  }
  function fmtEq(a: typeof runFmt) {
    return a.bold === st.bold && a.italic === st.italic && a.under === st.under;
  }
  function wrapFmt(html: string, f: typeof runFmt): string {
    if (f.under) html = `<u>${html}</u>`;
    if (f.italic) html = `<em>${html}</em>`;
    if (f.bold) html = `<strong>${html}</strong>`;
    return html;
  }
  function endRun() {
    flushBytes();
    if (runStart >= 0 && runText.length) {
      const rid = "r" + ridSeq++;
      runs.push({ rid, start: runStart, end: runEnd, text: runText });
      curParts.push(wrapFmt(`<span data-rid="${rid}">${esc(runText)}</span>`, runFmt));
    }
    runStart = -1; runEnd = -1; runText = ""; runBytes = [];
  }
  function startRunIfNeeded(idx: number) {
    if (runStart < 0) {
      runStart = idx;
      runFmt = { bold: st.bold, italic: st.italic, under: st.under };
      runByteCp = st.cp;
    } else if (!fmtEq(runFmt)) {
      // 서식이 바뀌면 런 분리.
      endRun();
      runStart = idx;
      runFmt = { bold: st.bold, italic: st.italic, under: st.under };
      runByteCp = st.cp;
    }
  }
  function addChar(idx: number, bytes: number[] | null, uni: string | null) {
    if (skipping) return;
    startRunIfNeeded(idx);
    runEnd = idx;
    if (bytes) {
      if (st.cp !== runByteCp) { flushBytes(); runByteCp = st.cp; }
      runBytes.push(...bytes);
    } else if (uni != null) {
      flushBytes(); runByteCp = st.cp; // uni 는 직접 문자
      runText += uni;
    }
  }
  function endPara() {
    endRun();
    paras.push(`<p class="rtf-p">${curParts.join("") || "<br/>"}</p>`);
    curParts = [];
  }

  // \uc 스킵 카운트(현 기본 1).
  let ucSkip = 1;
  let pendingUniSkip = 0; // \u 뒤 건너뛸 문자수

  for (let idx = 0; idx < toks.length; idx++) {
    const tk = toks[idx]!;
    if (tk.t === "open") {
      groupDepth++;
      skipStack.push(skipping);
      fmtStack.push({ bold: st.bold, italic: st.italic, under: st.under, cp: st.cp });
      continue;
    }
    if (tk.t === "close") {
      skipping = skipStack.pop() ?? false;
      const f = fmtStack.pop();
      if (f) { st.bold = f.bold; st.italic = f.italic; st.under = f.under; st.cp = f.cp; }
      groupDepth--;
      if (fontTblDepth >= 0 && groupDepth < fontTblDepth) fontTblDepth = -1;
      continue;
    }
    if (tk.t === "ctrl") {
      const w = tk.word;
      // 목적지 진입(그룹 첫 토큰일 필요 없이, 알려진 목적지면 건너뜀 시작).
      if (w === "*") { skipping = true; continue; }
      if (SKIP_DEST.has(w)) {
        skipping = true;
        if (w === "fonttbl") { fontTblDepth = groupDepth; curFontNum = null; }
        continue;
      }
      // 폰트테이블 안: \fN 정의, \fcharsetN.
      if (inFontTbl()) {
        if (w === "f" && tk.param != null) curFontNum = tk.param;
        else if (w === "fcharset" && tk.param != null && curFontNum != null) {
          st.fontCp.set(curFontNum, CHARSET_CP[tk.param] ?? 1252);
        }
        continue;
      }
      // 본문 제어워드.
      if (w === "ansicpg" && tk.param != null) { st.ansicpg = tk.param; st.cp = tk.param; continue; }
      if (w === "f" && tk.param != null) {
        // 폰트 선택 → 코드페이지 전환(있으면).
        const cp = st.fontCp.get(tk.param);
        if (cp != null) st.cp = cp;
        else st.cp = st.ansicpg;
        continue;
      }
      if (w === "uc" && tk.param != null) { ucSkip = tk.param; continue; }
      if (w === "b") { if (!skipping) endRunIfFmtChange(); st.bold = tk.param !== 0; continue; }
      if (w === "i") { if (!skipping) endRunIfFmtChange(); st.italic = tk.param !== 0; continue; }
      if (w === "ul") { if (!skipping) endRunIfFmtChange(); st.under = true; continue; }
      if (w === "ulnone") { if (!skipping) endRunIfFmtChange(); st.under = false; continue; }
      if (w === "plain") { if (!skipping) endRunIfFmtChange(); st.bold = st.italic = st.under = false; continue; }
      // `\` 바로 뒤 CR/LF 는 RTF 스펙상 \par 등가(macOS 등이 즐겨 씀).
      if (w === "par" || w === "sect" || w === "\n" || w === "\r") { if (!skipping) endPara(); continue; }
      if (w === "line") { if (!skipping) { endRun(); curParts.push("<br/>"); } continue; }
      if (w === "tab") { if (!skipping) addChar(idx, [0x09], null); continue; }
      if (w === "~") { if (!skipping) addChar(idx, null, " "); continue; }
      if (w === "_" || w === "-") { continue; } // (non)break hyphen — 표시 생략
      if (w === "pard") { continue; } // 문단 속성 리셋(런 유지)
      // 그 외 제어워드는 표시에 영향 없음.
      continue;
    }
    if (skipping) continue;
    if (tk.t === "hex") {
      if (pendingUniSkip > 0) { pendingUniSkip--; continue; }
      addChar(idx, [tk.byte], null);
      continue;
    }
    if (tk.t === "uni") {
      addChar(idx, null, String.fromCodePoint(tk.cp));
      pendingUniSkip = ucSkip;
      continue;
    }
    if (tk.t === "text") {
      // 리터럴 텍스트(주로 ASCII). \uc 스킵이 걸려있으면 글자 단위로 소비.
      let text = tk.text;
      if (pendingUniSkip > 0) {
        const drop = Math.min(pendingUniSkip, text.length);
        pendingUniSkip -= drop;
        text = text.slice(drop);
        if (!text) continue;
        // 부분 소비된 텍스트는 별도 처리: 바이트로 넣음.
      }
      const bytes: number[] = [];
      for (let k = 0; k < text.length; k++) bytes.push(text.charCodeAt(k) & 0xff);
      addChar(idx, bytes, null);
      continue;
    }
    // raw(CR/LF): 무시.
  }
  // 잔여 문단.
  endRun();
  if (curParts.length) paras.push(`<p class="rtf-p">${curParts.join("")}</p>`);

  function endRunIfFmtChange() {
    // 서식 변경 직전에 현재 런을 끊는다(다음 문자에서 새 서식으로 시작).
    if (runStart >= 0) endRun();
  }

  return { html: `<div class="docloom-doc rtf-doc">${paras.join("\n")}</div>`, runs };
}

// ── 디코딩(decode): 편집 HTML + 원본 토큰 → RTF 바이트 ───────────────────────
/** 새 텍스트를 RTF 본문 인코딩으로: ASCII 는 리터럴(이스케이프), 그 외는 \uN 유니코드. */
function encodeRtfText(text: string): string {
  let out = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (ch === "\\" || ch === "{" || ch === "}") out += "\\" + ch;
    else if (ch === "\t") out += "\\tab ";
    else if (ch === "\n") out += "\\line ";
    else if (cp < 0x80) out += ch;
    else {
      // \uN + 대체문자(\uc1 기본 가정). 음수 표현 없이 양수 코드포인트 사용(서로게이트 분해).
      if (cp > 0xffff) {
        const v = cp - 0x10000;
        const hi = 0xd800 + (v >> 10), lo = 0xdc00 + (v & 0x3ff);
        out += `\\u${hi}?\\u${lo}?`;
      } else {
        out += `\\u${cp > 0x7fff ? cp - 0x10000 : cp}?`;
      }
    }
  }
  return out;
}

function htmlToRtf(html: string, manifest: Manifest): Uint8Array {
  const origLatin1 = bytesToLatin1(manifest.originalParts["source.rtf"]!);
  const toks = tokenize(origLatin1);
  // 원본 런 매핑 재생성(인코딩과 동일 경로) → rid→{start,end}.
  const { runs } = rtfToHtmlAndMap(toks);
  const runById = new Map(runs.map((r) => [r.rid, r]));

  // 편집된 HTML 에서 rid→새 텍스트.
  const root = parse(html);
  const editById = new Map<string, string>();
  for (const el of root.querySelectorAll("[data-rid]")) {
    const rid = el.getAttribute("data-rid")!;
    // <br> 은 줄바꿈으로.
    const inner = el.innerHTML.replace(/<br\s*\/?>(?:\r?\n)?/gi, "\n");
    editById.set(rid, parse(`<x>${inner}</x>`).text);
  }

  // 바뀐 런만 추려 토큰 구간 교체. 구간 겹침 없음(런은 분리 토큰범위).
  type Patch = { start: number; end: number; replacement: string };
  const patches: Patch[] = [];
  for (const r of runs) {
    const neu = editById.get(r.rid);
    if (neu == null) continue; // HTML 에서 사라진 런(삭제) — v1 은 보존(원본 유지)
    if (neu === r.text) continue; // 변경 없음
    // {\uc1 ...} 그룹으로 감싼다: \uN 유니코드의 대체문자 스킵수(1)를 국소화해
    // 바깥 \ucN 컨텍스트와 무관하게 안전하고, 바깥 서식(굵게/폰트)은 그룹이 상속한다.
    patches.push({ start: r.start, end: r.end, replacement: `{\\uc1 ${encodeRtfText(neu)}}` });
  }
  if (!patches.length) return latin1ToBytes(origLatin1); // 무편집 = 바이트 동일

  patches.sort((a, b) => a.start - b.start);
  // 토큰 raw 를 이어붙이되, 패치 구간 [start,end] 의 문자토큰을 replacement(latin1) 로 대체.
  let out = "";
  let pi = 0;
  for (let idx = 0; idx < toks.length; idx++) {
    const p = patches[pi];
    if (p && idx === p.start) {
      out += p.replacement; // 새 텍스트(ASCII/\uN — latin1 안전)
      idx = p.end; // 구간 끝까지 건너뜀
      pi++;
      continue;
    }
    out += toks[idx]!.raw;
  }
  return latin1ToBytes(out);
}

// ── 미리보기 ─────────────────────────────────────────────────────────────────
export function rtfToPreviewHtml(bytes: Uint8Array, opts: PreviewOptionsBase = {}): string {
  const { html } = rtfToHtmlAndMap(tokenize(bytesToLatin1(bytes)));
  const css = `
  .docloom-doc.rtf-doc { font-family: "Times New Roman", "Batang", serif; font-size: 15px; line-height: 1.6; color:#1c2233; }
  .docloom-doc.rtf-doc .rtf-p { margin: 0 0 .5em; min-height: 1em; }
  `;
  // 미리보기에선 data-rid 가 불필요하지만 그대로 둬도 무해.
  return toPreviewHtml(html, { ...opts, css: ((opts as any).css ?? "") + css });
}

export function rtfEncode(bytes: Uint8Array): EncodeResultBase {
  const { html } = rtfToHtmlAndMap(tokenize(bytesToLatin1(bytes)));
  const manifest: Manifest = {
    version: 1,
    format: "rtf",
    container: "text",
    originalParts: { "source.rtf": bytes },
    native: {},
    frozen: {},
    props: {},
    paletteId: "rtf",
  };
  return { html, manifest };
}

export function rtfDecode(html: string, manifest: Manifest): Uint8Array {
  return htmlToRtf(html, manifest);
}

export const rtfAdapter: FormatAdapter = {
  id: "rtf",
  label: "서식 있는 텍스트 (.rtf)",
  supportsRoundTrip: true,
  detect() {
    // 평문 컨테이너라 zip part 로는 판별하지 않는다(registry 가 매직 `{\rtf` 로 라우팅).
    return false;
  },
  encode(bytes) {
    return rtfEncode(bytes);
  },
  decode(html, manifest) {
    return rtfDecode(html, manifest);
  },
  toPreviewHtml(bytes, opts) {
    return rtfToPreviewHtml(bytes, (opts ?? {}) as PreviewOptionsBase);
  },
};
