/**
 * .doc 길이 변경 편집(relayout) — piece 분할 + 끝에 append 전략.
 *
 * ── 왜 in-place 가 안 되나 ────────────────────────────────────────────────────
 * .doc 의 문자/문단 서식은 CP 가 아니라 **FC(WordDocument 바이트 오프셋)** 기준 FKP 로
 * 인덱싱된다. 텍스트를 본문 한가운데서 늘리면 뒤따르는 FKP 페이지·bin table 페이지번호가
 * 전부 밀려 깨진다. 그래서 in-place 성장은 불가.
 *
 * ── 채택 전략: piece 분할 + append(미편집 영역 서식 100% 보존) ─────────────────
 * 변경된 piece 를 [편집전][편집후][편집뒤] 3조각으로 쪼갠다.
 *   - [편집전]/[편집뒤] = 원본 FC 그대로 → FKP·서식 그대로 적용(보존).
 *   - [편집후] = WordDocument **맨 끝에 새로 append** 한 FC → 그 구간만 FKP 미적용(기본
 *     글자서식). 단 문단끝 CR 이 [편집뒤]에 남으므로 **문단 서식(정렬/스타일)은 보존**되고
 *     편집된 런의 인라인 글자서식(굵게/색 등)만 기본값이 된다.
 * 그 뒤 piece table(CLX)을 재작성하고, FIB ccpText·fcMac 과 CP 인덱스 plex(섹션/도형)를
 * Δ만큼 시프트한다.
 *
 * ⚠ 한계(정직히): 편집 런 인라인 글자서식 리셋. 필드/책갈피/각주 등 일부 CP 인덱스 구조는
 *   시프트 대상에서 빠질 수 있어(오프셋 미검증분) 편집 지점 뒤 위치가 어긋날 수 있다.
 *   그래서 기본은 거부(allowRelayout 옵트인일 때만 수행)하고, 무편집/같은길이 편집은
 *   기존 in-place 경로를 쓴다.
 */
import type { FibInfo, Piece } from "../formats/doc-fib.js";

/** UTF-16LE 인코딩(코드유닛 단위). */
function utf16le(text: string): Uint8Array {
  const out = new Uint8Array(text.length * 2);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < text.length; i++) dv.setUint16(i * 2, text.charCodeAt(i), true);
  return out;
}

/** 두 문자열의 공통 접두/접미 길이로 최소 변경구간 [a, len-b) 를 구한다. */
function diffRange(o: string, r: string): { a: number; bOld: number; bNew: number } {
  const max = Math.min(o.length, r.length);
  let a = 0;
  while (a < max && o[a] === r[a]) a++;
  let b = 0;
  while (b < max - a && o[o.length - 1 - b] === r[r.length - 1 - b]) b++;
  return { a, bOld: o.length - b, bNew: r.length - b };
}

/** 한 piece 의 PCD raw(8B)에서 머리(2B)·prm(2B)을 보존해 새 fc 로 PCD 를 만든다. */
function makePcd(head: Uint8Array, fcEncoded: number, prm: Uint8Array): Uint8Array {
  const pcd = new Uint8Array(8);
  pcd.set(head.subarray(0, 2), 0);
  new DataView(pcd.buffer).setUint32(2, fcEncoded >>> 0, true);
  pcd.set(prm.subarray(0, 2), 6);
  return pcd;
}

/** fcStart(바이트오프셋)+압축여부 → PCD fc 인코딩. */
function encodeFc(fcStart: number, compressed: boolean): number {
  return compressed ? ((fcStart * 2) | 0x40000000) >>> 0 : fcStart >>> 0;
}

export interface RelayoutResult {
  newWordDocument: Uint8Array;
  newTable: Uint8Array;
  /** WordDocument 의 FIB 안에서 갱신해야 할 필드(이미 newWordDocument 에 반영됨). */
}

/**
 * 변경된 piece 들의 새 텍스트로 relayout 수행.
 * @param wordDocument 원본 WordDocument 스트림
 * @param table 원본 Table 스트림
 * @param fib 파싱된 FIB
 * @param pieces 원본 piece 배열
 * @param pcdRaw 각 piece 의 원본 PCD raw(8B)
 * @param rgprcBytes CLX 의 RgPrc 접두 바이트(Pcdt 이전)
 * @param newTexts pieceIndex → 새 전체 텍스트(바뀐 piece 만 존재). 텍스트 도메인 = 디코드 문자열.
 */
export function relayoutDoc(
  wordDocument: Uint8Array,
  table: Uint8Array,
  fib: FibInfo,
  pieces: Piece[],
  pcdRaw: Uint8Array[],
  rgprcBytes: Uint8Array,
  origTexts: Map<number, string>,
  newTexts: Map<number, string>,
): RelayoutResult {
  // 1) WordDocument 끝에 append 할 새 텍스트들을 모은다.
  const appends: Uint8Array[] = [];
  let appendCursor = wordDocument.length;

  // 새 piece 목록(순서대로). 각 항목 = {cpLen, pcd(8B)}.
  interface NP { charCount: number; pcd: Uint8Array }
  const newPieces: NP[] = [];
  // CP 시프트 누적용 편집점 목록(글로벌 CP, delta).
  const edits: { startCP: number; delta: number }[] = [];

  for (const piece of pieces) {
    const neu = newTexts.get(piece.index);
    if (neu === undefined) {
      // 미변경 piece → 원본 PCD 그대로.
      newPieces.push({ charCount: piece.charCount, pcd: pcdRaw[piece.index]! });
      continue;
    }
    const orig = origTexts.get(piece.index) ?? "";
    if (neu === orig) {
      newPieces.push({ charCount: piece.charCount, pcd: pcdRaw[piece.index]! });
      continue;
    }
    const head = pcdRaw[piece.index]!;
    const prm = pcdRaw[piece.index]!.subarray(6, 8);
    const csz = piece.compressed ? 1 : 2;
    const { a, bOld, bNew } = diffRange(orig, neu);
    const leftLen = a;
    const midOld = orig.slice(a, bOld);
    const midNew = neu.slice(a, bNew);
    const rightLen = orig.length - bOld;

    // [편집전] — 원본 FC, 원본 압축.
    if (leftLen > 0) {
      newPieces.push({ charCount: leftLen, pcd: makePcd(head, encodeFc(piece.fcStart, piece.compressed), prm) });
    }
    // [편집후] — 새 append FC, 비압축 UTF-16(편집 문자 무손실).
    if (midNew.length > 0) {
      const bytes = utf16le(midNew);
      appends.push(bytes);
      newPieces.push({ charCount: midNew.length, pcd: makePcd(head, encodeFc(appendCursor, false), prm) });
      appendCursor += bytes.length;
    }
    // [편집뒤] — 원본 FC + (left+midOld)*csz, 원본 압축.
    if (rightLen > 0) {
      const rightFc = piece.fcStart + (leftLen + midOld.length) * csz;
      newPieces.push({ charCount: rightLen, pcd: makePcd(head, encodeFc(rightFc, piece.compressed), prm) });
    }
    // CP 시프트 기록: 편집은 piece 내 a 위치(글로벌 cpStart+a)에서 일어나고 Δ=neu.len-orig.len.
    edits.push({ startCP: piece.cpStart + a, delta: neu.length - orig.length });
  }

  // 2) 새 WordDocument = 원본 + append 들.
  const totalAppend = appends.reduce((s, b) => s + b.length, 0);
  const newWd = new Uint8Array(wordDocument.length + totalAppend);
  newWd.set(wordDocument, 0);
  {
    let c = wordDocument.length;
    for (const b of appends) { newWd.set(b, c); c += b.length; }
  }

  // 3) 새 CLX(piece table) 직렬화 → Table 끝에 append, fcClx/lcbClx 갱신.
  const n = newPieces.length;
  const cps: number[] = [0];
  for (const np of newPieces) cps.push(cps[cps.length - 1]! + np.charCount);
  const plcLen = (n + 1) * 4 + n * 8;
  const clx = new Uint8Array(rgprcBytes.length + 1 + 4 + plcLen);
  let o = 0;
  clx.set(rgprcBytes, o); o += rgprcBytes.length;
  clx[o++] = 0x02; // Pcdt 마커
  new DataView(clx.buffer).setUint32(o, plcLen, true); o += 4;
  const dvClx = new DataView(clx.buffer);
  for (let i = 0; i <= n; i++) { dvClx.setUint32(o, cps[i]! >>> 0, true); o += 4; }
  for (let i = 0; i < n; i++) { clx.set(newPieces[i]!.pcd, o); o += 8; }

  const newTable = new Uint8Array(table.length + clx.length);
  newTable.set(table, 0);
  newTable.set(clx, table.length);
  const newFcClx = table.length;
  const newLcbClx = clx.length;

  // 4) FIB 필드 갱신(newWd 안에서). ccpText += ΣΔ(본문 편집), fcMac, fcClx/lcbClx.
  const totalDelta = edits.reduce((s, e) => s + e.delta, 0);
  const dvWd = new DataView(newWd.buffer, newWd.byteOffset, newWd.byteLength);
  // fcMac(@0x1c) = fcMin + 총 본문문자(레거시 추정값; CLX 인식 리더는 CLX 사용).
  const newCcpText = fib.ccpText + totalDelta;
  dvWd.setInt32(0x001c, fib.fcMin + newCcpText, true);
  dvWd.setUint32(0x004c, newCcpText >>> 0, true); // ccpText
  dvWd.setUint32(0x01a2, newFcClx >>> 0, true);   // fcClx
  dvWd.setUint32(0x01a6, newLcbClx >>> 0, true);  // lcbClx

  // 5) CP 인덱스 plex 시프트: 한 CP 가 어떤 편집점보다 뒤면 그만큼 +Δ.
  function shiftCP(cp: number): number {
    let d = 0;
    for (const e of edits) if (cp > e.startCP) d += e.delta;
    return cp + d;
  }
  // (fc, lcb, cbStruct). cbStruct=0 이면 CP 만 있는 plex(PlcfHdd).
  const PLEXES: [number, number, number][] = [
    [fib.fcPlcfSed, fib.lcbPlcfSed, 12],       // 섹션
    [fib.fcPlcfHdd, fib.lcbPlcfHdd, 0],        // 머리말/꼬리말 스토리 경계
    [fib.fcPlcfspaMom, fib.lcbPlcfspaMom, 26], // 본문 도형 앵커(FSPA)
  ];
  const dvT = new DataView(newTable.buffer, newTable.byteOffset, newTable.byteLength);
  for (const [fc, lcb, cb] of PLEXES) {
    if (!fc || lcb < 8) continue;
    if (fc + lcb > table.length) continue; // 범위 밖이면 스킵(손상 방지)
    // PLC: (m+1) CP(u32) + m struct(cb). lcb = (m+1)*4 + m*cb.
    const m = cb === 0 ? lcb / 4 - 1 : (lcb - 4) / (4 + cb);
    if (m < 0 || !Number.isInteger(m)) continue;
    for (let i = 0; i <= m; i++) {
      const off = fc + i * 4;
      const cp = dvT.getUint32(off, true);
      dvT.setUint32(off, shiftCP(cp) >>> 0, true);
    }
  }

  return { newWordDocument: newWd, newTable };
}
