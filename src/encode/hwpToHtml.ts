/**
 * encode: hwp(HWP 5.0 바이너리) → (DocModel) → 제약 의미적 HTML + Manifest
 *
 * 원본 .hwp 컨테이너를 통째로 manifest 에 보관하고(디렉터리 트리·메타 완전 보존), 본문은
 * 섹션 레코드를 "문단 단위"로 풀어 편집 채널(HTML)로 노출한다.
 *   - 편집 가능 문단: 텍스트 + (헤더/charShape/lineSeg) 템플릿을 manifest.props 에 보관 →
 *     decode 가 이 템플릿을 복제해 텍스트 갈아끼우기는 물론 문단 추가/삭제까지 재직렬화.
 *   - 컨트롤/복합서식 문단: 원본 레코드를 manifest.frozen 에 보관(refId 로 복원).
 */
import type { Palette } from "../palette/palette.js";
import { htmlTagFromStyleKey, styleKeyFromDocxId } from "../palette/palette.js";
import { buildPaletteFromHwp, parseCharMarksFromDocInfo } from "../hwp/docinfo.js";
import type { DocModel, Block, Run, Mark } from "../model/docModel.js";
import type { Manifest } from "../model/manifest.js";
import { serializeModelToHtml } from "./docxToHtml.js";
import { readCfb } from "../core/cfb.js";
import { bytesToBase64 } from "../core/base64.js";
import { parseFileHeader, hwpInflate, serializeRecords } from "../hwp/record.js";
import { sectionToParaUnits, type ParaUnit } from "../hwp/section.js";

/** 원본 .hwp 컨테이너 바이트를 manifest.originalParts 에 담는 키. */
export const HWP_CONTAINER_KEY = " hwp-container";
/** 신규 문단이 복제할 기본 템플릿 토큰. */
export const HWP_DEFAULT_TEMPLATE = "hp-default";

export interface HwpEncodeOptions {
  palette?: Palette;
}
export interface HwpEncodeResult {
  html: string;
  manifest: Manifest;
  model: DocModel;
}

interface Store {
  props: Record<string, string>;
  frozen: Record<string, string>;
  hpSeq: number;
  /** charShapeId → props 토큰(같은 글자모양은 토큰 재사용). */
  csTokens: Map<number, string>;
  csSeq: number;
}

/** 한 charShapeId 에 대한 런 직접서식 토큰을 발급(중복 제거). */
function csToken(store: Store, csId: number): string {
  const existing = store.csTokens.get(csId);
  if (existing) return existing;
  const token = `hcs-${store.csSeq++}`;
  store.csTokens.set(csId, token);
  store.props[token] = String(csId);
  return token;
}

export function listHwpSectionPaths(streams: Record<string, Uint8Array>): string[] {
  return Object.keys(streams)
    .filter((p) => /^BodyText\/Section\d+$/.test(p))
    .sort((a, b) => sectionNum(a) - sectionNum(b));
}
function sectionNum(p: string): number {
  const m = p.match(/Section(\d+)$/);
  return m ? Number(m[1]) : 0;
}

export function encodeHwpToHtml(hwp: Uint8Array, opts: HwpEncodeOptions = {}): HwpEncodeResult {
  const cfb = readCfb(hwp);
  const fhStream = cfb.streams["FileHeader"];
  if (!fhStream) throw new Error("HWP: FileHeader 스트림이 없음(HWP 5.0 아님)");
  const fh = parseFileHeader(fhStream);
  if (!fh.signatureOk) throw new Error("HWP: 시그니처 불일치(HWP Document File 아님)");
  if (fh.distribution) throw new Error("HWP: 배포용 문서(본문 추가 암호화)는 아직 지원하지 않습니다.");

  const docInfoRaw = cfb.streams["DocInfo"];
  if (!docInfoRaw) throw new Error("HWP: DocInfo 스트림이 없음");
  const docInfo = fh.compressed ? hwpInflate(docInfoRaw) : docInfoRaw;

  const palette = opts.palette ?? buildPaletteFromHwp(docInfo);
  const charMarks = parseCharMarksFromDocInfo(docInfo);

  const sectionPaths = listHwpSectionPaths(cfb.streams);
  if (sectionPaths.length === 0) throw new Error("HWP: BodyText/Section* 본문을 찾을 수 없음");

  const store: Store = { props: {}, frozen: {}, hpSeq: 0, csTokens: new Map(), csSeq: 0 };
  const baseLevels: Record<string, number> = {};
  const blocks: Block[] = [];

  sectionPaths.forEach((path, si) => {
    if (si > 0) blocks.push({ type: "frozen", refId: `secbound-${si}`, label: "[섹션 경계]" });
    const raw = cfb.streams[path]!;
    const units = sectionToParaUnits(fh.compressed ? hwpInflate(raw) : raw);
    baseLevels[path] = units[0]?.baseLevel ?? 0;
    units.forEach((unit, ui) => {
      blocks.push(unitToBlock(unit, palette, charMarks, store, si, ui));
    });
  });

  const model: DocModel = { blocks };
  const manifest: Manifest = {
    version: 1,
    format: "hwp",
    container: "cfb",
    originalParts: { [HWP_CONTAINER_KEY]: hwp },
    frozen: store.frozen,
    props: store.props,
    paletteId: palette.id,
    native: {
      sections: JSON.stringify(sectionPaths),
      compressed: fh.compressed ? "1" : "0",
      baseLevels: JSON.stringify(baseLevels),
    },
  };

  const html = serializeModelToHtml(model, palette);
  return { html, manifest, model };
}

function unitToBlock(
  unit: ParaUnit,
  palette: Palette,
  charMarks: Map<number, Mark[]>,
  store: Store,
  si: number,
  ui: number,
): Block {
  if (!unit.editable) {
    const refId = `hwppara-${si}-${ui}`;
    store.frozen[refId] = bytesToBase64(serializeRecords(unit.records));
    return { type: "frozen", refId, label: "[개체/서식 문단]" };
  }

  // 편집 가능 문단: 헤더/charShape/lineSeg + 원본 텍스트를 템플릿으로 보관
  const tpl = JSON.stringify({
    h: bytesToBase64(unit.headerData ?? new Uint8Array(22)),
    c: unit.charShapeData ? bytesToBase64(unit.charShapeData) : "",
    l: unit.lineSegData ? bytesToBase64(unit.lineSegData) : "",
    t: unit.text,
  });
  const token = `hp-${store.hpSeq++}`;
  store.props[token] = tpl;
  if (!store.props[HWP_DEFAULT_TEMPLATE]) {
    // 신규 문단용 기본 템플릿(레이아웃/텍스트 비움)
    store.props[HWP_DEFAULT_TEMPLATE] = JSON.stringify({
      h: bytesToBase64(unit.headerData ?? new Uint8Array(22)),
      c: unit.charShapeData ? bytesToBase64(unit.charShapeData) : "",
      l: "",
      t: "",
    });
  }

  const styleKey = styleKeyFromDocxId(palette, String(unit.styleId));
  const htmlTag = htmlTagFromStyleKey(palette, styleKey);
  const runs = splitRunsByCharShape(unit, charMarks, store);

  if (/^h[1-6]$/.test(htmlTag)) {
    const level = Number(htmlTag.slice(1)) as 1 | 2 | 3 | 4 | 5 | 6;
    return { type: "heading", level, styleKey, runs, propsRef: token };
  }
  if (htmlTag === "li") {
    return { type: "listItem", ordered: false, level: 0, styleKey, runs, propsRef: token };
  }
  return { type: "paragraph", styleKey, runs, propsRef: token };
}

/**
 * 문단 텍스트를 PARA_CHAR_SHAPE 경계로 쪼개 런 배열로 만든다. 각 런은 자신의 charShapeId 를
 * propsRef(`hcs-*` 토큰 → props 에 csId)로 실어 보내 decode 가 글자모양을 재구성하게 한다.
 * (한 단어만 굵게/크게인 흔한 문단도 이렇게 런 단위로 편집 가능해진다.)
 */
function splitRunsByCharShape(unit: ParaUnit, charMarks: Map<number, Mark[]>, store: Store): Run[] {
  const text = unit.text;
  if (text.length === 0) return [];
  const cr = unit.charRuns.length ? unit.charRuns : [{ pos: 0, shapeId: 0 }];
  const clamp = (n: number) => Math.min(Math.max(n, 0), text.length);

  const runs: Run[] = [];
  for (let i = 0; i < cr.length; i++) {
    const start = i === 0 ? 0 : clamp(cr[i]!.pos);
    const end = i + 1 < cr.length ? clamp(cr[i + 1]!.pos) : text.length;
    if (end <= start) continue; // 빈 구간(중복 pos 등) 스킵
    const csId = cr[i]!.shapeId;
    const run: Run = { text: text.slice(start, end), propsRef: csToken(store, csId) };
    const marks = charMarks.get(csId);
    if (marks && marks.length) run.marks = [...marks];
    runs.push(run);
  }
  if (runs.length === 0) {
    // 경계가 비정상이면 첫 글자모양으로 통째 한 런
    const csId = cr[0]!.shapeId;
    const run: Run = { text };
    const marks = charMarks.get(csId);
    if (marks && marks.length) run.marks = [...marks];
    runs.push(run);
  }
  // 단일 글자모양 문단은 propsRef 를 생략(decode 가 템플릿 첫 글자모양으로 동일 복원).
  // → 출력 HTML 이 기존과 동일하게 깔끔하고, 다중 글자모양 문단만 런별 토큰을 갖는다.
  if (runs.length === 1) delete runs[0]!.propsRef;
  return runs;
}
