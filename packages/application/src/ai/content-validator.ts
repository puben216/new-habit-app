import {
  CONTENT_SAFETY_REASON_CODES,
  type ContentSafetyReasonCode,
  type ContentSafetyStatus,
} from "@habit-app/contracts";

import {
  ENDORSEMENT_PATTERNS,
  ENDORSEMENT_REQUEST_PATTERNS,
  REPRODUCTION_PATTERNS,
  compactText,
  matchesAny,
  normalizeText,
} from "./text-inspection";

/**
 * 生成本文の決定論的な公開ゲート(docs/specs/ai-contracts.md AIC-004、IPG-003)。
 * 純粋関数。モデルの自己申告には依存せず、管理された policy と文字列規則だけで判定する。
 */
export const CONTENT_VALIDATOR_VERSION = "content-safety-validator/1";

/** 引用符内がこの文字数以上なら長い引用とみなす。 */
export const LONG_QUOTATION_MIN_CHARS = 40;
/** 許可資料 excerpt とこの文字数以上の連続一致があれば過度な一致とみなす。 */
export const SOURCE_OVERLAP_MIN_CHARS = 20;

export interface ContentSafetyPolicy {
  /** 管理対象の第三者名称(書名・著者名・ブランド名等)。コードに埋め込まず設定から注入する。 */
  readonly managedTerms: readonly string[];
  /** 許可資料の excerpt(権利確認済みのもののみ)。過度な連続一致の検出に使う。 */
  readonly referenceExcerpts: readonly string[];
}

export interface ContentSafetyAssessment {
  readonly status: ContentSafetyStatus;
  readonly reasonCodes: readonly ContentSafetyReasonCode[];
  readonly validatorVersion: string;
}

/** reason code ごとの status。Record なので code 追加時に埋め忘れると compile error になる(AIC-INV-006)。 */
const REASON_STATUS: Record<ContentSafetyReasonCode, "fallback" | "required_human_review"> = {
  third_party_name: "fallback",
  promotional_use_of_third_party_name: "required_human_review",
  endorsement_claim: "fallback",
  long_quotation: "fallback",
  excessive_source_overlap: "fallback",
  reproduction_instruction: "fallback",
};

const PROMOTION_PATTERN =
  /(購入|販売|おすすめ|オススメ|キャンペーン|割引|クーポン|商品名|機能名|ブランド名|限定|申し込|申込|公式ストア|プレミアム|buy now|sale|discount)/;

const QUOTATION_PATTERNS: readonly RegExp[] = [
  /「([^」]*)」/g,
  /『([^』]*)』/g,
  /“([^”]*)”/g,
  /"([^"]*)"/g,
];

function containsManagedTerm(text: string, terms: readonly string[]): boolean {
  const compact = compactText(text);
  return terms.some((term) => {
    const needle = compactText(term);
    return needle.length > 0 && compact.includes(needle);
  });
}

function hasLongQuotation(text: string): boolean {
  const normalized = normalizeText(text);
  return QUOTATION_PATTERNS.some((pattern) =>
    Array.from(normalized.matchAll(pattern)).some(
      (match) => (match[1] ?? "").length >= LONG_QUOTATION_MIN_CHARS,
    ),
  );
}

function buildShingles(excerpts: readonly string[]): Set<string> {
  const shingles = new Set<string>();
  for (const excerpt of excerpts) {
    const compact = compactText(excerpt);
    for (let i = 0; i + SOURCE_OVERLAP_MIN_CHARS <= compact.length; i += 1) {
      shingles.add(compact.slice(i, i + SOURCE_OVERLAP_MIN_CHARS));
    }
  }
  return shingles;
}

function overlapsSource(text: string, shingles: ReadonlySet<string>): boolean {
  if (shingles.size === 0) return false;
  const compact = compactText(text);
  for (let i = 0; i + SOURCE_OVERLAP_MIN_CHARS <= compact.length; i += 1) {
    if (shingles.has(compact.slice(i, i + SOURCE_OVERLAP_MIN_CHARS))) return true;
  }
  return false;
}

function strictest(
  codes: readonly ContentSafetyReasonCode[],
): "pass" | "fallback" | "required_human_review" {
  if (codes.length === 0) return "pass";
  return codes.some((code) => REASON_STATUS[code] === "required_human_review")
    ? "required_human_review"
    : "fallback";
}

/**
 * 出力中のすべての文字列を検査する。該当した reason code はすべて返し、
 * status は `required_human_review` > `fallback` > `pass` の最も厳しいもの。
 */
export function validateGeneratedContent(
  texts: readonly string[],
  policy: ContentSafetyPolicy,
): ContentSafetyAssessment {
  const found = new Set<ContentSafetyReasonCode>();
  const shingles = buildShingles(policy.referenceExcerpts);

  for (const text of texts) {
    if (containsManagedTerm(text, policy.managedTerms)) {
      found.add("third_party_name");
      if (PROMOTION_PATTERN.test(normalizeText(text))) {
        found.add("promotional_use_of_third_party_name");
      }
    }
    if (matchesAny(ENDORSEMENT_PATTERNS, text)) found.add("endorsement_claim");
    if (hasLongQuotation(text)) found.add("long_quotation");
    if (overlapsSource(text, shingles)) found.add("excessive_source_overlap");
    if (matchesAny(REPRODUCTION_PATTERNS, text)) found.add("reproduction_instruction");
  }

  // 定義順で安定させる(出力順が入力順に依存しない)。
  const reasonCodes = CONTENT_SAFETY_REASON_CODES.filter((code) => found.has(code));
  return {
    status: strictest(reasonCodes),
    reasonCodes,
    validatorVersion: CONTENT_VALIDATOR_VERSION,
  };
}

/**
 * ユーザー自由記述に対する事前検査。第三者文章の再現・翻訳・文体模倣、公式を装う要求を検出する。
 * 該当すれば provider を呼ばない。第三者名への単なる言及は拒否しない(入力されたこと自体は問題ではない)。
 */
export function inspectGenerationRequest(texts: readonly string[]): ContentSafetyReasonCode[] {
  const found = new Set<ContentSafetyReasonCode>();
  for (const text of texts) {
    if (matchesAny(REPRODUCTION_PATTERNS, text)) found.add("reproduction_instruction");
    if (matchesAny(ENDORSEMENT_REQUEST_PATTERNS, text)) found.add("endorsement_claim");
  }
  return CONTENT_SAFETY_REASON_CODES.filter((code) => found.has(code));
}
