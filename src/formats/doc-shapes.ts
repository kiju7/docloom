/**
 * .doc(Word 97-2003) OfficeArt 드로잉(도형/선/사각형/텍스트박스) 파서.
 *
 * 도형은 두 군데에 나뉘어 저장된다:
 *   - **FSPA**(PlcfspaMom/Hdr, Table 스트림): 각 도형의 앵커 CP + 위치 사각형(twips) + spid.
 *   - **OfficeArt dgg**(fcDggInfo, Table 스트림): spid 별 도형 종류(FSP)와
 *      선/채움/점선 속성(FOPT). dgg 컨테이너를 재귀 순회해 spid→속성을 모은다.
 *
 * OfficeArt 색 u32 = 0x00BBGGRR (R 이 최하위 바이트) → CSS #RRGGBB.
 * 길이 EMU(914400/inch) → px(96dpi)는 /9525.
 *
 * 미리보기 한계: 절대좌표 레이아웃 대신 **앵커 CP 위치에 인라인 블록**으로 근사한다
 *   (자동 페이지나눔 엔진과 호환). 선=테두리 div, 사각형/박스=테두리+배경 div.
 */

/** spid 별 도형 속성. */
export interface ShapeProps {
  /** msospt 도형종류(FSP recInstance). 20=Line, 1=Rect, 202=TextBox, 0=group/custom. */
  type: number;
  hasLine: boolean;
  lineColor?: string;
  lineWidthPx: number;
  /** CSS border-style: "dotted" | "dashed" | "solid". */
  lineStyle: string;
  hasFill: boolean;
  fillColor?: string;
  /** 텍스트박스(FOPT lTxid 0x0380 존재). 내부 텍스트를 따로 채운다. */
  hasText?: boolean;
}

/** FSPA 앵커 1개. */
export interface ShapeAnchor {
  cp: number;
  spid: number;
  wPx: number;
  hPx: number;
  props: ShapeProps | undefined;
  /** 텍스트박스 내부 텍스트(렌더러가 txbx 스토리에서 채움). */
  text?: string;
}

const emuToPx = (emu: number) => Math.max(1, Math.round(emu / 9525));
const twipsToPx = (tw: number) => Math.round((tw / 1440) * 96);

/** OfficeArt 색(0x00BBGGRR) → "#rrggbb". 스킴색(상위바이트 플래그)은 근사 무시. */
function artColor(v: number): string {
  const r = v & 0xff;
  const g = (v >> 8) & 0xff;
  const b = (v >> 16) & 0xff;
  const h = (n: number) => n.toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** lineDashing(0x1d6) → CSS border-style. */
function dashStyle(d: number): string {
  if (d === 2 || d === 8) return "dotted"; // dot / sysDot
  if (d >= 1) return "dashed"; // dash/longdash/dashdot 류
  return "solid";
}

// ───────────────────────── dgg(도형 속성) ─────────────────────────

/** OfficeArt dgg 컨테이너를 순회해 spid→ShapeProps 맵을 만든다. */
export function parseShapeProps(art: Uint8Array): Map<number, ShapeProps> {
  const map = new Map<number, ShapeProps>();
  if (!art.length) return map;
  const dv = new DataView(art.buffer, art.byteOffset, art.byteLength);
  let curSpid = -1;
  let curType = 0;

  const walk = (start: number, end: number, depth: number) => {
    let pos = start;
    let guard = 0;
    while (pos + 8 <= end && guard++ < 100000) {
      const ver = dv.getUint16(pos, true);
      const type = dv.getUint16(pos + 2, true);
      const len = dv.getUint32(pos + 4, true);
      const inst = ver >> 4;
      if (type < 0xf000 || type > 0xf200) {
        pos += 1;
        continue;
      }
      if ((ver & 0x000f) === 0x000f) {
        // 컨테이너 → 하강. 0xF004(SpContainer) 진입 시 도형 상태 초기화.
        if (type === 0xf004) {
          curSpid = -1;
          curType = 0;
        }
        if (depth < 24) walk(pos + 8, Math.min(end, pos + 8 + len), depth + 1);
        pos += 8 + len;
        continue;
      }
      if (type === 0xf00a && pos + 12 <= end) {
        // FSP: spid(u32)@+8, 도형종류 = 레코드 instance.
        curSpid = dv.getUint32(pos + 8, true);
        curType = inst;
        if (!map.has(curSpid)) {
          map.set(curSpid, { type: curType, hasLine: false, lineWidthPx: 1, lineStyle: "solid", hasFill: false });
        } else {
          map.get(curSpid)!.type = curType;
        }
      } else if ((type === 0xf00b || type === 0xf122) && curSpid >= 0) {
        applyFopt(dv, pos + 8, Math.min(end, pos + 8 + len), inst, getOrInit(map, curSpid, curType));
      }
      if (pos + 8 + len > end) break;
      pos += 8 + len;
    }
  };
  walk(0, art.length, 0);
  return map;
}

function getOrInit(map: Map<number, ShapeProps>, spid: number, type: number): ShapeProps {
  let s = map.get(spid);
  if (!s) {
    s = { type, hasLine: false, lineWidthPx: 1, lineStyle: "solid", hasFill: false };
    map.set(spid, s);
  }
  return s;
}

/** FOPT 속성 배열(id:u16, value:u32 × nProp)을 ShapeProps 에 반영. */
function applyFopt(dv: DataView, start: number, end: number, nProp: number, s: ShapeProps): void {
  let p = start;
  for (let k = 0; k < nProp && p + 6 <= end; k++) {
    const id = dv.getUint16(p, true);
    const val = dv.getUint32(p + 2, true);
    const pid = id & 0x3fff;
    p += 6;
    switch (pid) {
      case 0x0181: // fillColor
        s.fillColor = artColor(val);
        break;
      case 0x01bf: // fillStyleBooleans (fFilled = bit 0x10)
        s.hasFill = (val & 0x10) !== 0;
        break;
      case 0x01c0: // lineColor
        s.lineColor = artColor(val);
        break;
      case 0x01cb: // lineWidth (EMU)
        s.lineWidthPx = emuToPx(val);
        break;
      case 0x01d6: // lineDashing
        s.lineStyle = dashStyle(val);
        break;
      case 0x01ff: // lineStyleBooleans (fLine = bit 0x8)
        s.hasLine = (val & 0x8) !== 0;
        break;
      case 0x0380: // lTxid (텍스트박스 식별자) → 내부 텍스트 있음
        s.hasText = true;
        break;
      default:
        break;
    }
  }
}

// ───────────────────────── FSPA(앵커) ─────────────────────────

/** PlcfspaMom/Hdr(FSPA 26바이트) → 앵커 목록. */
export function parseFspa(table: Uint8Array, fc: number, lcb: number, props: Map<number, ShapeProps>): ShapeAnchor[] {
  // lcb = (n+1)*4 + n*26 = 30n+4
  if (lcb < 34 || (lcb - 4) % 30 !== 0 || fc + lcb > table.length) return [];
  const n = (lcb - 4) / 30;
  const dv = new DataView(table.buffer, table.byteOffset, table.byteLength);
  const cps: number[] = [];
  for (let i = 0; i <= n; i++) cps.push(dv.getInt32(fc + i * 4, true));
  const base = fc + (n + 1) * 4;
  const out: ShapeAnchor[] = [];
  for (let i = 0; i < n; i++) {
    const o = base + i * 26;
    const spid = dv.getUint32(o, true);
    const xL = dv.getInt32(o + 4, true);
    const yT = dv.getInt32(o + 8, true);
    const xR = dv.getInt32(o + 12, true);
    const yB = dv.getInt32(o + 16, true);
    out.push({
      cp: cps[i]!,
      spid,
      wPx: twipsToPx(Math.abs(xR - xL)),
      hPx: twipsToPx(Math.abs(yB - yT)),
      props: props.get(spid),
    });
  }
  return out;
}

/** 한 도형 앵커 → 미리보기 HTML(인라인 블록 근사). 렌더 불가면 "". */
export function shapeHtml(a: ShapeAnchor): string {
  const p = a.props;
  if (!p) return "";
  const color = p.lineColor ?? "#000000";
  const lw = Math.max(1, p.lineWidthPx);

  // 선(msosptLine=20) 또는 한 변이 0 인 도형 → 가로/세로 선.
  if (p.type === 20 || a.hPx <= 2 || a.wPx <= 2) {
    if (a.wPx >= a.hPx) {
      // 가로선
      const w = a.wPx > 4 ? `width:${Math.min(a.wPx, 900)}px;max-width:100%` : "width:100%";
      return `<div class="doc-shape-line" style="${w};border-top:${lw}px ${p.lineStyle} ${color};margin:6px 0"></div>`;
    }
    // 세로선
    return `<div class="doc-shape-line" style="display:inline-block;height:${Math.max(a.hPx, 8)}px;border-left:${lw}px ${p.lineStyle} ${color}"></div>`;
  }

  // 사각형/박스/텍스트박스 → 테두리(+배경) 박스(+내부 텍스트).
  const border = p.hasLine ? `border:${lw}px ${p.lineStyle} ${color};` : "";
  const bg = p.hasFill && p.fillColor && p.fillColor !== "#ffffff" ? `background:${p.fillColor};` : "";
  const txt = a.text ? esc(a.text) : "";
  if (!border && !bg && !txt) return "";
  const w = a.wPx > 4 ? `width:${Math.min(a.wPx, 900)}px;max-width:100%;` : "";
  const h = a.hPx > 4 ? `min-height:${a.hPx}px;` : "";
  const pad = txt ? "padding:4px 8px;" : "";
  return `<div class="doc-shape-box" style="${w}${h}${border}${bg}${pad}box-sizing:border-box;margin:6px 0">${txt}</div>`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
