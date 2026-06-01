<div align="center">

# docloom

**문서를 양식 그대로 미리보고, HTML로 편집한 뒤, 원본 포맷으로 되돌리는 TypeScript 라이브러리**

![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)
![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)
![Pure TS](https://img.shields.io/badge/no%20LibreOffice-pure%20TS-orange)

</div>

---

docloom은 **Office·한글·PDF 문서를 브라우저에서 미리보고**, 일부 포맷은 **깨끗한 HTML ↔ 원본**을
**무손실로 왕복**한다. 외부 변환 엔진(LibreOffice 등) 없이 순수 TypeScript로 동작한다.

docloom은 **"미리보기 + 왕복 채널"만** 책임진다. HTML을 어떻게 편집할지는 호출하는 쪽이 정한다.
문서를 다루기 쉬운 HTML로 바꿨다가, 원본 양식 그대로 되돌리는 용도에 맞다.

## 지원 포맷

| 포맷 | 미리보기 | 왕복 |
|---|:---:|:---:|
| **docx / hwpx / csv** | O | O 무손실 |
| **doc · ppt** (97–2003) | O | 텍스트 |
| **hwp** (한글 5.0) | O | O (편집은 `.hwpx` 출력) |
| **pptx · xlsx · xls** | O | 로드맵 |
| **pdf** | O 위치보존 | X (고정 레이아웃) |
| **md · html · txt** | O | O |

## 빠른 시작

```bash
npm install
npm run build
npm test
```

**미리보기** — 포맷은 자동 판별된다:

```ts
import { previewHtml } from "docloom";
import { readFileSync, writeFileSync } from "node:fs";

const bytes = new Uint8Array(readFileSync("sample.hwpx")); // docx/pdf/ppt… 무엇이든
writeFileSync("preview.html", previewHtml(bytes, { title: "미리보기" }));
```

**편집 + 왕복**:

```ts
import { encode, decode } from "docloom";

const { html, manifest } = encode(bytes);   // 편집용 HTML + 복원 키트
//  ... html 을 편집 ...
const restored = decode(editedHtml, manifest); // 원본 양식 보존한 새 문서
```

> 두 HTML을 구분하세요.
> `previewHtml()`은 보기 전용(왕복 불가), `encode().html`은 편집/왕복용 본문 조각(`manifest`와 짝).

## 데모

```bash
npm run demo:build    # demo/docloom.mjs 번들 생성
npx serve demo        # 또는 demo/index.html 직접 열기
```

파일을 드래그하면 포맷을 자동 판별해 미리보기한다.

## 다른 언어에서 쓰기 (HTTP API)

docloom은 Node/TS 라이브러리다. Python·Go·Java·C++ 등에서는 **작은 HTTP 서버로 띄워** 호출한다.
저장소에 의존성 없는 서버(`server.mjs`)가 들어 있다:

```bash
npm run build
npm run serve         # http://localhost:8080
```

| 엔드포인트 | 입력 | 출력 |
|---|---|---|
| `POST /preview` | 문서 바이트 | 미리보기 HTML |
| `POST /encode` | 문서 바이트 | `{ html, manifest }` (JSON) |
| `POST /decode` | `/encode` 응답 JSON | 양식 보존한 문서 바이트 |

> 왕복은 `/encode` 응답 JSON을 그대로 `/decode`에 돌려보내면 된다(`manifest` 내부 바이너리는 서버가 알아서 처리).

**Python**
```python
import requests
html = requests.post("http://localhost:8080/preview",
                     data=open("a.hwpx", "rb").read()).text
open("preview.html", "w").write(html)
```

**Go**
```go
b, _ := os.ReadFile("a.docx")
resp, _ := http.Post("http://localhost:8080/preview", "application/octet-stream", bytes.NewReader(b))
html, _ := io.ReadAll(resp.Body)
```

**Java**
```java
var req = HttpRequest.newBuilder(URI.create("http://localhost:8080/preview"))
    .POST(HttpRequest.BodyPublishers.ofFile(Path.of("a.pdf"))).build();
String html = HttpClient.newHttpClient().send(req, BodyHandlers.ofString()).body();
```

**C++ / 그 외** — `curl`로 동일하게:
```bash
curl --data-binary @a.docx http://localhost:8080/preview -o preview.html
```

## 어떻게 양식을 보존하나

<div align="center">
  <img src="./docs/roundtrip.svg" alt="docloom 왕복 흐름: 원본 문서를 encode 하면 편집용 html 과 복원 키트 manifest 가 나오고, html 만 편집한 뒤 decode 하면 양식이 100% 보존된 문서로 돌아온다" width="100%">
</div>

encode 결과는 **편집용 `html` + 복원 키트 `manifest`** 한 쌍이다.
manifest가 원본 전체(스타일·머리말·이미지·표 등)를 보관하므로, decode는 **본문만** 재생성하고
나머지는 원본 그대로 둔다 → **양식이 물리적으로 안 깨진다.** 아직 이해 못 하는 요소(표·도형)는
원본을 그대로 보관(frozen)해 왕복이 깨지지 않는다.

## 주요 API

| 함수 | 설명 |
|---|---|
| `previewHtml(bytes, opts?)` | 포맷 자동판별 미리보기 |
| `encode(bytes)` / `decode(html, manifest)` | 포맷 자동판별 왕복 |
| `encodeToHtml` / `decodeToDocx` | docx 전용 (저수준) |
| `validateHtml(html, palette)` | 편집된 HTML 안전 교정 |
| `registerImageDecoder(filter, fn)` | PDF JPX/JBIG2 디코더 외부 연결 |

> 새 포맷 = `FormatAdapter`(`src/core/format.ts`) 구현 후 `registry.ts`에 등록. docx가 본보기다.

## 의존성

`fflate`(zip), `fast-xml-parser`(XML), `node-html-parser`(편집 HTML), `@rhwp/core`(한글 엔진).
변환 매핑 로직은 전부 docloom이 직접 구현한다.

## 라이선스

[MIT](./LICENSE)
