/**
 * 특수기호(special symbol) 코드포인트 분류 + 텍스트 추출 유틸.
 *
 * 사용자 핵심 불만 = "특수기호가 반영 안 됨". 이건 ground-truth 없이도 **신뢰성 있게**
 * 자동 검증된다: 원본 데이터에서 추출한 텍스트에 있는 기호가 렌더된 미리보기 텍스트에
 * **그대로 살아남았는지**만 보면 되기 때문(텍스트 in → 텍스트 out, 픽셀 불필요).
 *
 * "특수기호"의 정의: 일반 본문 글자(한글 음절·자모, 한자, ASCII 영숫자, 전각 영숫자,
 * 악센트 라틴문자, 공백)를 **제외한** 가시 기호 — ● ▶ ★ ※ ① ㈜ ℃ ㎡ → ± × ÷ § ° 등.
 * 글머리표·도형기호·단위기호·화살표·괄호번호가 여기 들어온다(누락되면 사용자가 바로 알아챔).
 */

/** 이 코드포인트가 "특수기호"인가(누락 추적 대상). */
export function isSpecialSymbol(cp: number): boolean {
  if (cp < 0x00a1) return false;                       // ASCII + 제어 + NBSP 이하 = 본문/공백
  // 유니코드 공백·구분자(보이지 않음) — 정렬용 figure space(U+2007) 등. "특수기호" 아님.
  if (cp >= 0x2000 && cp <= 0x200a) return false;       // 각종 공백(en/em/figure/thin…)
  if (cp === 0x2028 || cp === 0x2029) return false;     // 줄/문단 구분자
  if (cp === 0x202f || cp === 0x205f || cp === 0x1680) return false; // narrow/math/ogham 공백
  // 한글
  if (cp >= 0xac00 && cp <= 0xd7a3) return false;       // 음절
  if (cp >= 0x1100 && cp <= 0x11ff) return false;       // 자모
  if (cp >= 0x3130 && cp <= 0x318f) return false;       // 호환 자모
  if (cp >= 0xa960 && cp <= 0xa97f) return false;       // 자모 확장-A
  if (cp >= 0xd7b0 && cp <= 0xd7ff) return false;       // 자모 확장-B
  // 한자(본문 취급)
  if (cp >= 0x3400 && cp <= 0x9fff) return false;       // 한자 + 확장-A
  if (cp >= 0xf900 && cp <= 0xfaff) return false;       // 한자 호환
  if (cp >= 0x20000 && cp <= 0x2ffff) return false;     // 한자 확장 평면
  // 전각 영숫자(본문 취급)
  if (cp >= 0xff10 && cp <= 0xff19) return false;       // ０-９
  if (cp >= 0xff21 && cp <= 0xff3a) return false;       // Ａ-Ｚ
  if (cp >= 0xff41 && cp <= 0xff5a) return false;       // ａ-ｚ
  // 악센트 라틴 문자(본문 취급) — 단 × ÷ 는 기호로 남김
  if (cp >= 0x00c0 && cp <= 0x00ff && cp !== 0x00d7 && cp !== 0x00f7) return false;
  if (cp >= 0x0100 && cp <= 0x024f) return false;       // 라틴 확장 A/B
  if (cp === 0x3000) return false;                      // 한자 공백(표의문자 공백)
  if (cp === 0xfeff || cp === 0x200b) return false;     // BOM / zero-width
  return true;                                          // 그 외 = 특수기호 후보
}

/** 문자열에서 특수기호의 멀티셋(기호→개수). 서로게이트 쌍 처리. */
export function specialSymbolCounts(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const ch of s) {                                 // for..of = 코드포인트 단위
    const cp = ch.codePointAt(0)!;
    if (isSpecialSymbol(cp)) m.set(ch, (m.get(ch) ?? 0) + 1);
  }
  return m;
}

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
};

/** HTML → 보이는 텍스트(태그 제거 + 기본/숫자 엔티티 디코드). 누락 검사용. */
export function htmlToVisibleText(html: string): string {
  // <style>/<script> 본문은 제거(보이는 텍스트 아님)
  let h = html.replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  h = h.replace(/<[^>]+>/g, " ");                       // 태그 제거
  h = h.replace(/&#x([0-9a-f]+);/gi, (_, x) => safeCp(parseInt(x, 16)));
  h = h.replace(/&#(\d+);/g, (_, d) => safeCp(parseInt(d, 10)));
  h = h.replace(/&([a-z]+);/gi, (whole, name) => ENTITIES[name.toLowerCase()] ?? whole);
  return h;
}

function safeCp(cp: number): string {
  try { return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : ""; } catch { return ""; }
}
