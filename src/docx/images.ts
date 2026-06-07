/**
 * docx frozen 그림 런(w:drawing/w:pict) → 실제 임베드 이미지 `<img>` (미리보기·편집 표시용).
 *
 * 왕복은 frozen XML(manifest.frozen) + data-frozen 토큰으로 보존되므로, 표시만 라벨("[그림]")
 * 대신 진짜 이미지로 바꾼다(decode 는 토큰만 보고 내부 내용은 무시 → 무손실 유지).
 *
 * 그림 바이트 = a:blip r:embed(또는 r:link) → word/_rels/document.xml.rels 의 Target →
 * word/media/imageN.ext. 표시크기 = wp:extent cx/cy(EMU). EMF/WMF 등 브라우저 미지원은 null
 * (호출측이 라벨로 폴백).
 */
import { bytesToBase64 } from "../core/base64.js";

const MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  bmp: "image/bmp", tif: "image/tiff", tiff: "image/tiff", webp: "image/webp", svg: "image/svg+xml",
};

/** word/_rels/document.xml.rels → Map<rId, zip경로>. 외부링크(TargetMode=External)는 제외. */
function relationshipMap(parts: Record<string, Uint8Array>): Map<string, string> {
  const m = new Map<string, string>();
  const rel = parts["word/_rels/document.xml.rels"];
  if (!rel) return m;
  const xml = new TextDecoder().decode(rel);
  for (const tag of xml.match(/<Relationship\b[^>]*\/?>/g) ?? []) {
    const id = tag.match(/\bId="([^"]+)"/)?.[1];
    const target = tag.match(/\bTarget="([^"]+)"/)?.[1];
    if (!id || !target) continue;
    if (/\bTargetMode="External"/.test(tag) || /^https?:/i.test(target)) continue;
    m.set(id, resolveTarget(target));
  }
  return m;
}

/** Target(문서 word/document.xml 기준 상대경로) → zip 절대경로 정규화. */
function resolveTarget(target: string): string {
  if (target.startsWith("/")) return target.slice(1);     // 패키지 루트 기준 절대
  const segs = ("word/" + target).split("/");
  const out: string[] = [];
  for (const s of segs) {
    if (s === "..") out.pop();
    else if (s && s !== ".") out.push(s);
  }
  return out.join("/");
}

/** frozen 그림 XML 1개 → `<img>` HTML(미해결/미지원이면 null).
 *  DrawingML(a:blip r:embed/r:link)·VML(w:pict 의 v:imagedata r:id) 둘 다 지원. */
function frozenImg(xml: string, rels: Map<string, string>, parts: Record<string, Uint8Array>): string | null {
  const rId = xml.match(/r:embed="([^"]+)"/)?.[1]
    ?? xml.match(/r:link="([^"]+)"/)?.[1]
    ?? xml.match(/r:id="([^"]+)"/)?.[1];                   // VML <v:imagedata r:id="…">
  if (!rId) return null;
  const path = rels.get(rId);
  if (!path) return null;
  const bytes = parts[path];
  if (!bytes || !bytes.length) return null;
  const ext = (path.split(".").pop() ?? "").toLowerCase();
  const mime = MIME[ext];
  if (!mime) return null;                                 // emf/wmf 등 → 라벨 폴백
  const dim = imgSize(xml);
  return `<img alt="" style="${dim}max-width:100%;vertical-align:top" src="data:${mime};base64,${bytesToBase64(bytes)}">`;
}

/** 표시크기 CSS: DrawingML wp:extent(EMU) 우선, 없으면 VML style width/height(pt). */
function imgSize(xml: string): string {
  const ex = xml.match(/<wp:extent\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/);
  if (ex) return `width:${Math.round(+ex[1]! / 9525)}px;height:${Math.round(+ex[2]! / 9525)}px;`;
  const w = xml.match(/[^-]width:\s*([\d.]+)pt/)?.[1];     // VML v:shape style (pt → px ×4/3)
  const h = xml.match(/height:\s*([\d.]+)pt/)?.[1];
  if (w && h) return `width:${Math.round(+w * 4 / 3)}px;height:${Math.round(+h * 4 / 3)}px;`;
  return "";
}

/** frozen 토큰(token→그림XML) → token→`<img>`HTML 맵(이미지로 해석된 것만). */
export function buildDocxFrozenImages(
  frozen: Record<string, string>,
  parts: Record<string, Uint8Array>,
): Map<string, string> {
  const rels = relationshipMap(parts);
  const out = new Map<string, string>();
  for (const [token, xml] of Object.entries(frozen)) {
    if (typeof xml !== "string") continue;
    const html = frozenImg(xml, rels, parts);
    if (html) out.set(token, html);
  }
  return out;
}
