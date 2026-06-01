/**
 * decode: 편집된 HTML + Manifest → .ppt(PowerPoint 97-2003 바이너리, OLE2/CFB)
 *
 * ── 채택 전략 ────────────────────────────────────────────────────────────────
 * (A) 길이 보존 in-place 패치 — 검증된 1급 경로(LOW RISK).
 *     편집한 텍스트가 같은 atom 타입으로 재인코딩했을 때 "같은 바이트 길이"면,
 *     "PowerPoint Document" 스트림의 해당 atom 본문 바이트만 제자리 덮어쓴다.
 *     → 그 뒤 모든 레코드의 바이트 오프셋이 그대로다 ⇒ PersistDirectoryAtom(0x1772)·
 *       UserEditAtom·Current User 의 절대 오프셋이 전혀 안 깨진다 ⇒ persist fixup 불필요.
 *
 * (B) 길이 변경 편집 — 베스트에포트 오프셋 재계산(HIGHER RISK, 부분 지원).
 *     편집으로 atom 본문 길이가 바뀌면, 그 atom 헤더의 recLen 을 갱신하고,
 *     스트림을 [delta] 만큼 뒤로 민 뒤:
 *       1) 조상 컨테이너들의 recLen 을 delta 만큼 누적 보정(트리 일관성).
 *       2) 모든 PersistDirectoryAtom 의 오프셋 엔트리 중, 편집 지점 이후를 가리키는
 *          것을 delta 만큼 이동.
 *       3) Current User 스트림 CurrentUserAtom 의 offsetToCurrentEdit, 그리고 스트림 내
 *          UserEditAtom(0x0FF5) 의 offsetLastEdit/offsetPersistDirectory 중 편집 지점
 *          이후를 가리키는 값을 delta 만큼 이동.
 *     ⚠ 한계: 실제 PowerPoint 재오픈은 환경상 자동 검증 불가. 레코드 트리 재파싱·
 *       오프셋 정합성까지는 보장한다. 안전을 위해 기본은 A 만 시도하고, 길이 변경은
 *       명시 옵트인(allowRelayout)일 때만 B 를 수행한다.
 *
 * 서식 보존: 텍스트 atom 은 문자 바이트만 담는다. 런/문단 서식은 StyleTextPropAtom 등
 * 별도 레코드에 있고 전혀 건드리지 않으므로, 텍스트만 바꿔도 서식은 자동 보존된다.
 */
import { parse } from "node-html-parser";
import type { Manifest } from "../model/manifest.js";
import { readCfb, writeCfb } from "../core/cfb.js";
import {
  collectTextAtoms,
  encodeAtomText,
  type TextAtomLoc,
} from "../formats/ppt-records.js";
import { PPT_SOURCE_KEY, PPT_DOC_STREAM, atomId } from "../encode/pptToHtml.js";

const REC_PERSIST_DIR = 0x1772; // PersistDirectoryAtom
const REC_USER_EDIT = 0x0ff5; // UserEditAtom
const CURRENT_USER_STREAM = "Current User";

export interface PptDecodeOptions {
  /** true 면 길이 변경 편집에 전략 B(오프셋 재계산) 를 허용. 기본 false(길이 변경 거부). */
  allowRelayout?: boolean;
}

/** HTML 의 data-atom 별 편집 텍스트 추출(<br>→\n, 블록 경계→\n). */
function readEditedText(html: string): Map<string, string> {
  const root = parse(html, { lowerCaseTagName: true, comment: false });
  const out = new Map<string, string>();
  for (const el of root.querySelectorAll("[data-atom]")) {
    const id = el.getAttribute("data-atom");
    if (id === undefined) continue;
    // <br> 를 \n 으로, 그 외 태그는 언랩하고 텍스트만. 엔티티는 parser 가 디코드.
    let inner = el.innerHTML;
    inner = inner.replace(/<br\s*\/?>/gi, "\n");
    // 남은 태그 제거 후 엔티티 디코드를 위해 다시 파싱.
    const tmp = parse(`<x>${inner}</x>`);
    const text = decodeEntities(tmp.querySelector("x")?.text ?? "");
    out.set(id, text);
  }
  return out;
}

/** node-html-parser 의 .text 는 엔티티를 이미 풀어주지만, 안전망으로 핵심 엔티티 처리. */
function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** 표시용으로 정리된 두 텍스트가 동일한지(CR/VT/NUL 정규화 후 비교). */
function sameDisplay(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/\r/g, "\n").replace(/\x0b/g, "\n").replace(/\x00/g, "");
  return norm(a) === norm(b);
}

export function decodeHtmlToPpt(html: string, manifest: Manifest, opts: PptDecodeOptions = {}): Uint8Array {
  const source = manifest.originalParts[PPT_SOURCE_KEY];
  if (!source) throw new Error("PPT manifest: 원본 컨테이너 바이트(__source__)가 없음");

  const cfb = readCfb(source);
  const docIdx = cfb.pathOf.get(PPT_DOC_STREAM);
  const docBytes = docIdx !== undefined ? cfb.data.get(docIdx) : undefined;
  if (docIdx === undefined || !docBytes) {
    throw new Error(`PPT: "${PPT_DOC_STREAM}" 스트림을 찾지 못했습니다.`);
  }

  const edited = readEditedText(html);
  const origText: Record<string, string> = JSON.parse(manifest.native?.origText ?? "{}");

  // 현재 스트림에서 atom 위치를 다시 수집(원본과 동일 — 아직 미편집 상태).
  const atoms = collectTextAtoms(docBytes);
  const byId = new Map<string, TextAtomLoc>();
  for (const a of atoms) byId.set(atomId(a), a);

  // 편집된 atom 목록 산출: 표시 텍스트가 원본과 달라진 것만.
  interface Patch {
    loc: TextAtomLoc;
    newBody: Uint8Array;
  }
  const patches: Patch[] = [];
  for (const [id, newText] of edited) {
    const loc = byId.get(id);
    if (!loc) continue; // 알 수 없는 id 는 무시(추가된 노드 등)
    const orig = origText[id] ?? loc.text;
    if (sameDisplay(newText, orig)) continue; // 변경 없음 → 건너뜀(원본 유지)

    const body = encodeAtomText(loc.recType, newText);
    if (!body) {
      throw new Error(
        `PPT atom ${id}: 편집 텍스트를 ${loc.recType === 0x0fa8 ? "TextBytes(Latin1)" : "TextChars"} 로 무손실 인코딩할 수 없습니다.`,
      );
    }
    patches.push({ loc, newBody: body });
  }

  if (patches.length === 0) {
    // 변경 없음 → 원본 그대로 재조립(바이트 동일성은 writeCfb 표준화 범위 내).
    return writeCfb({ entries: cfb.entries, data: cfb.data });
  }

  // 길이 변경 여부 판단.
  const lengthChanging = patches.some((p) => p.newBody.length !== p.loc.bodyLength);

  let newDoc: Uint8Array;
  if (!lengthChanging) {
    // ── 전략 A: 제자리 덮어쓰기(오프셋 불변) ──
    newDoc = docBytes.slice();
    for (const p of patches) newDoc.set(p.newBody, p.loc.bodyOffset);
  } else {
    if (!opts.allowRelayout) {
      throw new Error(
        "PPT: 길이가 바뀌는 텍스트 편집은 persist-offset 재계산(전략 B)이 필요합니다. " +
          "opts.allowRelayout=true 로 명시하면 베스트에포트로 재배치합니다(실 PowerPoint 재오픈 검증은 환경상 미보장).",
      );
    }
    newDoc = relayoutWithFixup(docBytes, patches);
    // Current User 스트림의 CurrentUserAtom 오프셋도 보정(있으면).
    fixupCurrentUser(cfb, patches);
  }

  cfb.data.set(docIdx, newDoc);
  return writeCfb({ entries: cfb.entries, data: cfb.data });
}

// ── 전략 B: 길이 변경 재배치 + 오프셋 fixup ──────────────────────────────────

/**
 * patches 를 적용해 스트림을 재직렬화하면서:
 *   - 각 편집 atom 의 recLen 갱신
 *   - 조상 컨테이너 recLen 을 delta 누적 보정
 *   - PersistDirectoryAtom 오프셋·UserEditAtom 오프셋을 편집 지점 기준 delta 이동
 * 여러 패치는 헤더 오프셋 오름차순으로 순차 적용(앞쪽 delta 가 뒤쪽 위치를 민다).
 */
function relayoutWithFixup(orig: Uint8Array, patches: { loc: TextAtomLoc; newBody: Uint8Array }[]): Uint8Array {
  // 헤더 오프셋 오름차순.
  const sorted = [...patches].sort((a, b) => a.loc.headerOffset - b.loc.headerOffset);

  let buf = orig.slice();
  // 누적 시프트로 인해 이미 적용된 패치 뒤의 오프셋이 밀린다 → 진행 중 누적 delta 추적.
  let cumShift = 0;
  for (const p of sorted) {
    const hdr = p.loc.headerOffset + cumShift; // 현재 buf 기준 헤더 위치
    const bodyStart = hdr + 8;
    const oldLen = p.loc.bodyLength;
    const newLen = p.newBody.length;
    const delta = newLen - oldLen;

    // 새 본문으로 교체.
    const before = buf.subarray(0, bodyStart);
    const after = buf.subarray(bodyStart + oldLen);
    const next = new Uint8Array(before.length + newLen + after.length);
    next.set(before, 0);
    next.set(p.newBody, bodyStart);
    next.set(after, bodyStart + newLen);
    buf = next;

    if (delta !== 0) {
      // 이 atom 헤더의 recLen 갱신.
      const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      dv.setUint32(hdr + 4, newLen, true);
      // 조상 컨테이너 recLen 보정 + persist/useredit 오프셋 이동(편집 지점 = bodyStart 기준).
      fixupAfterShift(buf, bodyStart, delta);
    }
    cumShift += delta;
  }
  return buf;
}

/**
 * buf 안에서 editPoint(편집된 본문 시작 절대오프셋) 이후가 delta 만큼 밀린 뒤의 정합성 보정.
 *   1) 레코드 트리를 다시 걸으며, editPoint 를 [내부에] 포함하는 모든 컨테이너의 recLen += delta.
 *   2) PersistDirectoryAtom 의 오프셋 엔트리 중 값 > editPoint 인 것 += delta.
 *   3) UserEditAtom 의 알려진 오프셋 필드 중 값 > editPoint 인 것 += delta.
 * 주의: recLen 은 이미 새 길이로 갱신된 편집 atom 자신은 제외한다.
 */
function fixupAfterShift(buf: Uint8Array, editPoint: number, delta: number): void {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  // 1) 조상 컨테이너 recLen 보정 — 트리 순회.
  const walk = (start: number, end: number): void => {
    let p = start;
    while (p + 8 <= end) {
      const verInst = dv.getUint16(p, true);
      const recType = dv.getUint16(p + 2, true);
      const recLen = dv.getUint32(p + 4, true);
      const bodyStart = p + 8;
      const isContainer = (verInst & 0x000f) === 0x000f;
      // editPoint 가 이 컨테이너 본문 안에 있으면 recLen += delta (편집으로 본문이 늘었으니).
      // 단, recLen 은 이미 delta 반영 전 값으로 읽었으니, 이 컨테이너가 편집 지점을 품으면 보정.
      const bodyEndOld = bodyStart + recLen; // delta 반영 전 끝(논리)
      if (isContainer && bodyStart < editPoint && editPoint <= bodyEndOld + Math.max(0, -delta)) {
        // 이 컨테이너는 편집 지점을 품는다 → 새 recLen.
        dv.setUint32(p + 4, recLen + delta, true);
        // 자식들을 새 길이 기준으로 순회.
        walk(bodyStart, bodyStart + recLen + delta);
        p = bodyStart + recLen + delta;
        continue;
      }
      // 편집 지점을 품지 않는 컨테이너: 길이 불변. 단 editPoint 이전 컨테이너는 그대로 순회.
      const bodyEnd = bodyStart + recLen;
      if (isContainer) walk(bodyStart, Math.min(bodyEnd, end));
      p = bodyEnd;
    }
  };
  walk(0, buf.length);

  // 2) & 3) persist/useredit 오프셋 보정 — 트리 재순회(컨테이너 recLen 은 이제 새 값).
  const fixOffsets = (start: number, end: number): void => {
    let p = start;
    while (p + 8 <= end) {
      const verInst = dv.getUint16(p, true);
      const recType = dv.getUint16(p + 2, true);
      const recLen = dv.getUint32(p + 4, true);
      const bodyStart = p + 8;
      const bodyEnd = bodyStart + recLen;
      if (bodyEnd > end) break;
      const isContainer = (verInst & 0x000f) === 0x000f;

      if (recType === REC_PERSIST_DIR && !isContainer) {
        // 본문 = PersistDirectoryEntry* : [persistIdAndCount u32][offset u32 * count] ...
        let q = bodyStart;
        while (q + 4 <= bodyEnd) {
          const pic = dv.getUint32(q, true);
          q += 4;
          const count = pic >>> 20; // 상위 12bit = cPersist
          for (let k = 0; k < count && q + 4 <= bodyEnd; k++, q += 4) {
            const off = dv.getUint32(q, true);
            if (off > editPoint) dv.setUint32(q, off + delta, true);
          }
        }
      } else if (recType === REC_USER_EDIT && !isContainer) {
        // UserEditAtom 의 알려진 오프셋 필드(LE u32):
        //   +0 lastSlideIdRef, +4 version, +8 offsetLastEdit, +12 offsetPersistDirectory,
        //   +16 docPersistIdRef, ... offsetLastEdit/offsetPersistDirectory 만 이동 대상.
        for (const fieldOff of [bodyStart + 8, bodyStart + 12]) {
          if (fieldOff + 4 <= bodyEnd) {
            const v = dv.getUint32(fieldOff, true);
            if (v > editPoint) dv.setUint32(fieldOff, v + delta, true);
          }
        }
      }

      if (isContainer) fixOffsets(bodyStart, bodyEnd);
      p = bodyEnd;
    }
  };
  fixOffsets(0, buf.length);
}

/** Current User 스트림 CurrentUserAtom 의 offsetToCurrentEdit 보정(편집 지점 이후면 이동). */
function fixupCurrentUser(
  cfb: ReturnType<typeof readCfb>,
  patches: { loc: TextAtomLoc; newBody: Uint8Array }[],
): void {
  const cuIdx = cfb.pathOf.get(CURRENT_USER_STREAM);
  if (cuIdx === undefined) return;
  const cu = cfb.data.get(cuIdx);
  if (!cu || cu.length < 12) return;

  // CurrentUserAtom: +0 size(u32), +4 magic(u32), +8 offsetToCurrentEdit(u32) ...
  const dv = new DataView(cu.buffer, cu.byteOffset, cu.byteLength);
  // 총 delta(모든 패치 합)와 가장 이른 편집 지점을 기준으로 보정.
  let totalDelta = 0;
  let earliest = Infinity;
  for (const p of patches) {
    totalDelta += p.newBody.length - p.loc.bodyLength;
    earliest = Math.min(earliest, p.loc.bodyOffset);
  }
  if (totalDelta === 0) return;
  const off = dv.getUint32(8, true);
  if (off > earliest) {
    const copy = cu.slice();
    new DataView(copy.buffer, copy.byteOffset, copy.byteLength).setUint32(8, off + totalDelta, true);
    cfb.data.set(cuIdx, copy);
  }
}
