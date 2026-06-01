/**
 * decode: 제약 HTML + Manifest → hwp(HWP 5.0 바이너리)
 *
 * 풀 편집 왕복: 원본 .hwp 컨테이너(manifest 보관)를 읽어, 섹션 본문 레코드를 DocModel 블록
 * 기준으로 "통째로 재생성"한다. 그래서 텍스트 편집뿐 아니라 문단 추가/삭제/이동까지 반영된다.
 *   - 편집 가능 문단 블록: props 템플릿(헤더/charShape/lineSeg)을 복제 → 텍스트·스타일 반영.
 *     신규 문단(템플릿 없음)은 기본 템플릿(hp-default)을 복제.
 *   - frozen 블록(컨트롤/복합서식·섹션경계): manifest.frozen 의 원본 레코드를 그대로 복원.
 * 컨트롤(표/그림) 자체의 내부 편집은 미지원(바이트 보존). DocInfo/BinData 등 다른 스트림은
 * 원본 그대로 두고 섹션 스트림만 교체한 뒤 CFB 로 재조립한다.
 */
import type { Palette } from "../palette/palette.js";
import { buildPaletteFromHwp } from "../hwp/docinfo.js";
import { docxIdFromStyleKey } from "../palette/palette.js";
import { validateHtml } from "../validate/validator.js";
import type { Manifest } from "../model/manifest.js";
import type { Block } from "../model/docModel.js";
import { parseHtmlToModel } from "./htmlToDocx.js";
import { readCfb, writeCfb } from "../core/cfb.js";
import { base64ToBytes } from "../core/base64.js";
import {
  parseFileHeader,
  hwpInflate,
  hwpDeflate,
  parseRecords,
  serializeRecords,
  patchParaHeader,
  stringToWchars,
  firstCharShapeId,
  type HwpRecord,
  HWPTAG_PARA_HEADER,
  HWPTAG_PARA_TEXT,
  HWPTAG_PARA_CHAR_SHAPE,
  HWPTAG_PARA_LINE_SEG,
} from "../hwp/record.js";
import type { Run } from "../model/docModel.js";
import { HWP_CONTAINER_KEY, HWP_DEFAULT_TEMPLATE } from "../encode/hwpToHtml.js";

export interface HwpDecodeOptions {
  palette?: Palette;
  skipValidate?: boolean;
}

interface Template {
  h: string; // base64 PARA_HEADER payload
  c: string; // base64 PARA_CHAR_SHAPE payload
  l: string; // base64 PARA_LINE_SEG payload
  t: string; // 원본 텍스트(변경 여부 판단 → LINE_SEG 재사용)
}

export function decodeHtmlToHwp(html: string, manifest: Manifest, opts: HwpDecodeOptions = {}): Uint8Array {
  const container = manifest.originalParts[HWP_CONTAINER_KEY];
  if (!container) throw new Error("HWP manifest: 원본 컨테이너 바이트가 없음");
  const cfb = readCfb(container);

  const fh = parseFileHeader(cfb.streams["FileHeader"] ?? new Uint8Array(0));
  const compressed = (manifest.native?.compressed ?? (fh.compressed ? "1" : "0")) === "1";

  const docInfo = compressed ? hwpInflate(cfb.streams["DocInfo"] ?? new Uint8Array(0)) : cfb.streams["DocInfo"] ?? new Uint8Array(0);
  const palette = opts.palette ?? buildPaletteFromHwp(docInfo);
  if (manifest.paletteId !== palette.id) {
    throw new Error(`팔레트 불일치: manifest=${manifest.paletteId} vs decode=${palette.id}.`);
  }

  const safeHtml = opts.skipValidate ? html : validateHtml(html, palette).html;
  const model = parseHtmlToModel(safeHtml, palette);

  // 섹션 경계 마커로 그룹 분리
  const groups: Block[][] = [[]];
  for (const b of model.blocks) {
    if (b.type === "frozen" && b.refId.startsWith("secbound-")) groups.push([]);
    else groups[groups.length - 1]!.push(b);
  }

  const sectionPaths: string[] = JSON.parse(manifest.native?.sections ?? "[]");
  const baseLevels: Record<string, number> = JSON.parse(manifest.native?.baseLevels ?? "{}");
  const defaultTpl = manifest.props[HWP_DEFAULT_TEMPLATE];

  sectionPaths.forEach((path, si) => {
    const idx = cfb.pathOf.get(path);
    if (idx === undefined) return;
    const baseLevel = baseLevels[path] ?? 0;
    const group = groups[si] ?? [];

    const records: HwpRecord[] = [];
    for (const block of group) {
      if (block.type === "frozen") {
        const raw = manifest.frozen[block.refId];
        if (raw !== undefined) records.push(...parseRecords(base64ToBytes(raw)));
        continue;
      }
      if (block.type === "table" || !("runs" in block)) continue;
      records.push(...buildParagraphRecords(block, baseLevel, manifest, palette, defaultTpl));
    }

    const serialized = serializeRecords(records);
    cfb.data.set(idx, compressed ? hwpDeflate(serialized) : serialized);
  });

  return writeCfb(cfb);
}

/** 문단 블록 → HWP 레코드들(헤더/텍스트/charShape[/lineSeg]). */
function buildParagraphRecords(
  block: Extract<Block, { runs: unknown }>,
  baseLevel: number,
  manifest: Manifest,
  palette: Palette,
  defaultTpl: string | undefined,
): HwpRecord[] {
  const styleId = Number(docxIdFromStyleKey(palette, block.styleKey)) || 0;

  const tplJson = (block.propsRef ? manifest.props[block.propsRef] : undefined) ?? defaultTpl;
  const tpl: Template = tplJson ? JSON.parse(tplJson) : { h: "", c: "", l: "", t: "" };

  const headerSrc = tpl.h ? base64ToBytes(tpl.h) : new Uint8Array(22);
  // 신규/서식없는 런이 참조할 기본 글자모양(템플릿의 첫 charShapeId).
  const defaultCsId = tpl.c ? firstCharShapeId(base64ToBytes(tpl.c)) ?? 0 : 0;

  // 텍스트 런(frozenRef 런 제외)만 모은다.
  const runs = ((block as { runs: Run[] }).runs ?? []).filter((r) => !r.frozenRef);
  const text = runs.map((r) => r.text ?? "").join("");
  const unchanged = tpl.t === text && tpl.l !== "" && tpl.c !== "";

  let charShape: Uint8Array;
  let charShapeCount: number;
  if (unchanged) {
    // 텍스트 미변경: 원본 글자모양 테이블·줄나눔을 그대로 재사용(완전 보존).
    charShape = base64ToBytes(tpl.c);
    charShapeCount = Math.max(1, Math.floor(charShape.length / 8));
  } else {
    // 런 길이로 PARA_CHAR_SHAPE 를 재구성: 각 런의 charShapeId(propsRef)와 누적 위치.
    const pairs: Array<[number, number]> = [];
    let pos = 0;
    for (const r of runs) {
      const t = r.text ?? "";
      if (t.length === 0) continue;
      const csId = runCharShapeId(r, manifest, defaultCsId);
      if (!pairs.length || pairs[pairs.length - 1]![1] !== csId) pairs.push([pos, csId]);
      pos += t.length; // 같은 csId 인접 런은 병합(위치만 누적)
    }
    if (pairs.length === 0) pairs.push([0, defaultCsId]);
    pairs[0]![0] = 0; // 첫 글자모양은 항상 위치 0
    charShape = buildCharShape(pairs);
    charShapeCount = pairs.length;
  }

  // HWP 문단 텍스트는 문단끝 문자(0x0D)로 끝난다 → 재직렬화 시 다시 붙인다.
  const textW = text + "\r";
  const header = patchParaHeader(headerSrc, {
    nChars: textW.length,
    styleId,
    charShapeCount,
    lineSegCount: unchanged ? undefined : 0, // 텍스트 변경/신규 → LINE_SEG 제거(한글이 재배치)
  });

  const out: HwpRecord[] = [
    { tag: HWPTAG_PARA_HEADER, level: baseLevel, data: header },
    { tag: HWPTAG_PARA_TEXT, level: baseLevel + 1, data: stringToWchars(textW) },
    { tag: HWPTAG_PARA_CHAR_SHAPE, level: baseLevel + 1, data: charShape },
  ];
  if (unchanged && tpl.l) {
    out.push({ tag: HWPTAG_PARA_LINE_SEG, level: baseLevel + 1, data: base64ToBytes(tpl.l) });
  }
  return out;
}

/** 런의 charShapeId 를 propsRef(`hcs-*` → props 에 csId 문자열)에서 읽는다. */
function runCharShapeId(r: Run, manifest: Manifest, fallback: number): number {
  if (r.propsRef) {
    const v = manifest.props[r.propsRef];
    if (v !== undefined) {
      const n = Number(v);
      if (Number.isFinite(n)) return n >>> 0;
    }
  }
  return fallback;
}

/** (pos, charShapeId) 쌍 배열 → PARA_CHAR_SHAPE 페이로드(8바이트 × N). */
function buildCharShape(pairs: Array<[number, number]>): Uint8Array {
  const out = new Uint8Array(pairs.length * 8);
  const dv = new DataView(out.buffer);
  pairs.forEach(([pos, id], i) => {
    dv.setUint32(i * 8, pos >>> 0, true);
    dv.setUint32(i * 8 + 4, id >>> 0, true);
  });
  return out;
}
