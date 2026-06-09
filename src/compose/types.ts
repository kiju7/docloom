/**
 * compose: 업로드 문서를 "양식"으로 쓰고, 프롬프트 자료를 그 양식의 편집노드에 채워
 * 양식 무손실 문서를 만드는 레이어의 공용 타입.
 *
 * 핵심 분리:
 *   - 추출(descriptor): 편집채널 HTML → 채울 수 있는 슬롯 목록(포맷 무관, 텍스트만)
 *   - 전략(FillStrategy): descriptor+자료 → 편집된 HTML (JSON 채움 / HTML 가드레일 등 교체 가능)
 *   - 주입(fill): 채움 결과를 편집노드에 되써넣기 (구조·data-* ref 불변)
 * 양식 보존은 decode 가 책임진다 — 우리는 노드의 텍스트만 바꾼다.
 */
import type { Manifest } from "../model/manifest.js";

/** 채울 수 있는 텍스트 슬롯 하나(편집채널의 블록 1개에 대응). */
export interface Slot {
  /** 안정 식별자. 같은 HTML 을 같은 순서로 걷는 한 추출/주입 간 일치한다(예: "s0"). */
  id: string;
  /** 역할 힌트 — LLM 이 어디에 무엇을 넣을지 판단하는 단서. */
  role: "heading" | "listItem" | "body" | "cell";
  /** 현재 텍스트(빈 양식이면 ""). */
  text: string;
}

/** 반복 단위(리스트 항목·문단 런 등). MVP: 단위=블록 1개. */
export interface RepeatGroup {
  groupId: string;
  /** 반복 단위 한 칸의 슬롯들(MVP 는 길이 1). */
  unit: { slotId: string; role: Slot["role"] }[];
  /** 이 그룹에 속한 슬롯 id 들(양식 예시 항목). */
  memberIds: string[];
  /** 양식에 들어있던 예시 항목 수(=memberIds.length). */
  sampleCount: number;
}

/** 편집채널에서 뽑아낸 양식 기술자. LLM 입력의 골격. */
export interface TemplateDescriptor {
  fixed: Slot[];
  groups: RepeatGroup[];
}

/** LLM 이 돌려준 채움 결과(JSON 전략). 바꾼 슬롯만 담아도 됨(나머지는 원본 유지). */
export interface FillResult {
  slots: Record<string, string>;
  /**
   * 반복그룹 채움: groupId → 항목 텍스트 배열. 배열 길이가 양식 예시 수보다 많으면 단위 노드를
   * 복제해 늘리고, 적으면 남는 예시 노드는 비운다. (MVP: 단위=블록 1개 = 리스트/문단 항목)
   */
  groups?: Record<string, string[]>;
}

/** 로컬/원격 LLM 추상화. Ollama 구현이 기본. */
export interface LlmClient {
  /** 설치된 모델 이름 목록(/api/tags). */
  listModels(): Promise<string[]>;
  /** JSON 강제 채팅. content 를 JSON 으로 파싱해 반환. */
  chatJson(args: { model: string; system: string; user: string }): Promise<unknown>;
}

/**
 * 채움 전략 — 같은 파이프라인(open→편집HTML→decode) 안에서 중간 단계만 교체한다.
 *   - JsonFill: 기술자→JSON 채움→되써넣기 (구조 불변 보장, 로컬모델 안전)
 *   - HtmlGuardrailFill(Stage 2): HTML 통째 편집→data-* diff 검증
 * 같은 fidelity 하베스트로 A/B 비교한다.
 */
export interface FillStrategy {
  name: string;
  fill(args: {
    /** encode 결과의 편집채널 HTML(<div class="docloom-doc">…). */
    editableHtml: string;
    manifest: Manifest;
    /** 사용자가 준 자료(프롬프트). */
    material: string;
    llm: LlmClient;
    model: string;
  }): Promise<{ editedHtml: string; meta?: Record<string, unknown> }>;
}
