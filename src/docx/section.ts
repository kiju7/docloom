/**
 * 섹션 속성(w:sectPr) 파싱 — 용지·여백·방향·다단·페이지테두리·머리말/꼬리말 참조.
 *
 * docx 의 sectPr 은 한 섹션의 페이지 레이아웃 전체를 담는다. 미리보기 렌더러가
 * 이 구조화된 값으로 A4/Letter 시트·가로세로 방향·다단(여러 단)·페이지 테두리를 그린다.
 *
 *   w:sectPr
 *     w:pgSz   @w:w @w:h @w:orient          용지 크기·방향
 *     w:pgMar  @w:top @w:right @w:bottom @w:left @w:header @w:footer @w:gutter
 *     w:cols   @w:num @w:space @w:sep [w:col @w:w @w:space ...]   다단
 *     w:pgBorders  w:top/left/bottom/right @w:sz @w:color @w:val   페이지 테두리
 *     w:type   @w:val (continuous|nextPage|oddPage|evenPage)        섹션 구분 종류
 *     w:titlePg                                                     첫 페이지 다름
 *     w:headerReference/w:footerReference @w:type @r:id             머리말/꼬리말 참조
 */
import { childrenOf, findChild, findChildren, attrOf, type XmlNode } from "./ooxml.js";

const TWIPS_TO_PX = 96 / 1440;
export const twPx = (tw: number): number => Math.round(tw * TWIPS_TO_PX);

/** 페이지 치수(px, 96dpi 기준). */
export interface PageGeom {
  wPx: number;
  hPx: number;
  topPx: number;
  rightPx: number;
  bottomPx: number;
  leftPx: number;
  headerPx: number; // 위 가장자리에서 머리말까지
  footerPx: number; // 아래 가장자리에서 꼬리말까지
}

/** 다단 설정. num=단 수, space=단 간격(px), sep=구분선 여부. */
export interface ColumnProps {
  num: number;
  space: number; // px
  sep: boolean;
  /** 단마다 폭이 다르면 각 단의 폭(px). 균등이면 비움. */
  widths?: { w: number; space: number }[];
}

/** 한 변의 테두리 CSS(없으면 undefined). 예: "2px solid #000". */
export interface PageBorders {
  top?: string;
  right?: string;
  bottom?: string;
  left?: string;
}

export interface SectionProps {
  page: PageGeom;
  orient: "portrait" | "landscape";
  gutterPx: number;
  cols: ColumnProps;
  type?: "continuous" | "nextPage" | "oddPage" | "evenPage";
  titlePg: boolean;
  borders?: PageBorders;
  /** 머리말 참조 rId(타입별). v1 렌더러는 default 만 사용. */
  headerRefs: Partial<Record<"default" | "first" | "even", string>>;
  footerRefs: Partial<Record<"default" | "first" | "even", string>>;
}

/** A4 세로 기본 섹션. */
export function defaultSectionProps(): SectionProps {
  return {
    page: {
      wPx: twPx(11906), hPx: twPx(16838),
      topPx: twPx(1440), rightPx: twPx(1440), bottomPx: twPx(1440), leftPx: twPx(1440),
      headerPx: twPx(720), footerPx: twPx(720),
    },
    orient: "portrait",
    gutterPx: 0,
    cols: { num: 1, space: twPx(720), sep: false },
    titlePg: false,
    headerRefs: {},
    footerRefs: {},
  };
}

export function parseSectionProps(sectPr: XmlNode | undefined): SectionProps {
  const s = defaultSectionProps();
  if (!sectPr) return s;
  const kids = childrenOf(sectPr);

  // 용지 크기 + 방향
  const pgSz = findChild(kids, "w:pgSz");
  if (pgSz) {
    let w = Number(attrOf(pgSz, "w:w"));
    let h = Number(attrOf(pgSz, "w:h"));
    const orient = attrOf(pgSz, "w:orient");
    if (orient === "landscape") s.orient = "landscape";
    if (Number.isFinite(w) && Number.isFinite(h)) {
      // orient=landscape 인데 폭이 더 작게 기록된 문서는 정규화해 가로로 보이게 한다.
      if (s.orient === "landscape" && w < h) [w, h] = [h, w];
      s.page.wPx = twPx(w);
      s.page.hPx = twPx(h);
    }
  }

  // 여백 + gutter
  const pgMar = findChild(kids, "w:pgMar");
  if (pgMar) {
    const num = (a: string) => Number(attrOf(pgMar, a));
    if (Number.isFinite(num("w:top"))) s.page.topPx = twPx(Math.abs(num("w:top")));
    if (Number.isFinite(num("w:right"))) s.page.rightPx = twPx(num("w:right"));
    if (Number.isFinite(num("w:bottom"))) s.page.bottomPx = twPx(Math.abs(num("w:bottom")));
    if (Number.isFinite(num("w:left"))) s.page.leftPx = twPx(num("w:left"));
    if (Number.isFinite(num("w:header"))) s.page.headerPx = twPx(num("w:header"));
    if (Number.isFinite(num("w:footer"))) s.page.footerPx = twPx(num("w:footer"));
    if (Number.isFinite(num("w:gutter"))) s.gutterPx = twPx(num("w:gutter"));
  }

  // 다단
  const cols = findChild(kids, "w:cols");
  if (cols) {
    const num = Number(attrOf(cols, "w:num"));
    const space = Number(attrOf(cols, "w:space"));
    s.cols.num = Number.isFinite(num) && num > 0 ? num : 1;
    if (Number.isFinite(space)) s.cols.space = twPx(space);
    s.cols.sep = isOn(attrOf(cols, "w:sep"));
    const colNodes = findChildren(childrenOf(cols), "w:col");
    if (colNodes.length > 1) {
      s.cols.num = colNodes.length;
      s.cols.widths = colNodes.map((c) => ({
        w: twPx(Number(attrOf(c, "w:w")) || 0),
        space: twPx(Number(attrOf(c, "w:space")) || 0),
      }));
    }
  }

  // 페이지 테두리
  const pgBorders = findChild(kids, "w:pgBorders");
  if (pgBorders) {
    const b: PageBorders = {};
    const bk = childrenOf(pgBorders);
    for (const side of ["top", "right", "bottom", "left"] as const) {
      const node = findChild(bk, `w:${side}`);
      const css = node ? borderToCss(node) : undefined;
      if (css) b[side] = css;
    }
    if (Object.keys(b).length > 0) s.borders = b;
  }

  // 섹션 구분 종류 / 첫 페이지 다름
  const type = attrOf(findChild(kids, "w:type") ?? {}, "w:val");
  if (type === "continuous" || type === "nextPage" || type === "oddPage" || type === "evenPage") {
    s.type = type;
  }
  if (findChild(kids, "w:titlePg")) s.titlePg = true;

  // 머리말/꼬리말 참조
  for (const ref of findChildren(kids, "w:headerReference")) {
    const t = (attrOf(ref, "w:type") ?? "default") as "default" | "first" | "even";
    const id = attrOf(ref, "r:id");
    if (id) s.headerRefs[t] = id;
  }
  for (const ref of findChildren(kids, "w:footerReference")) {
    const t = (attrOf(ref, "w:type") ?? "default") as "default" | "first" | "even";
    const id = attrOf(ref, "r:id");
    if (id) s.footerRefs[t] = id;
  }

  return s;
}

/** w:top/left/... 테두리 노드 → CSS border 문자열. */
function borderToCss(node: XmlNode): string | undefined {
  const val = attrOf(node, "w:val");
  if (val === "none" || val === "nil") return undefined;
  const sz = Number(attrOf(node, "w:sz")); // 1/8 pt
  const widthPt = Number.isFinite(sz) ? sz / 8 : 0.5;
  const widthPx = Math.max(1, Math.round((widthPt * 96) / 72));
  const color = attrOf(node, "w:color");
  const c = color && color.toLowerCase() !== "auto" ? `#${color}` : "#000";
  const style = val === "double" ? "double" : val === "dashed" ? "dashed" : val === "dotted" ? "dotted" : "solid";
  return `${widthPx}px ${style} ${c}`;
}

function isOn(v: string | undefined): boolean {
  if (v === undefined) return false;
  return !["0", "false", "off", "none"].includes(v.toLowerCase());
}
