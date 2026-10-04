/** 文字列検査の共通処理。比較用の正規化と、request/output 共通の再現指示パターン。 */

/** NFKC + 小文字化。全角半角・大文字小文字の揺れを吸収する。 */
export function normalizeText(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

/** 空白・句読点・括弧類を除いた比較用の文字列。名称や連続一致の揺れ(区切り文字)を吸収する。 */
export function compactText(value: string): string {
  return normalizeText(value).replace(
    /[\s　・･\-_.,、。，．'"「」『』“”‘’()（）[\]【】!?！？:：;；]/g,
    "",
  );
}

/** オブジェクトに含まれるすべての文字列値を集める(出力 schema が変わっても検査対象から漏れない)。 */
export function collectStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => collectStrings(item));
  if (typeof value === "object" && value !== null) {
    return Object.values(value).flatMap((item) => collectStrings(item));
  }
  return [];
}

/** 本文・翻訳・文体模倣などの再現を指示/示唆する表現。 */
export const REPRODUCTION_PATTERNS: readonly RegExp[] = [
  /(全文|本文|原文|一節|該当箇所|ページ).{0,8}(そのまま|丸ごと|コピー|転載|書き写|書き起こ|再現|貼り付|引用して)/,
  /(そのまま|丸ごと|コピー|転載|書き写|書き起こ).{0,8}(全文|本文|原文|出力|載せ|書いて)/,
  /(翻訳|和訳|日本語訳|英訳|訳して|訳した)/,
  /(文体|口調|語り口|話し方).{0,10}(真似|まね|模倣|で書|で話|で答|で説明|にして|を再現)/,
  /(風に|ふうに|っぽく|みたいに|のように).{0,4}(書いて|話して|語って|答えて)/,
  /(translate|verbatim|word for word|in the style of)/,
];

/** 公式・提携・監修などの示唆。 */
export const ENDORSEMENT_PATTERNS: readonly RegExp[] = [
  /(公式|提携|監修|公認|オフィシャル|認定済)/,
  /(official|endorsed|authorized by|in partnership with|licensed by)/,
];

/** ユーザー要求側: 公式・監修などを「装う」依頼だけを対象にする(「公式サイト」等の単なる言及は対象外)。 */
export const ENDORSEMENT_REQUEST_PATTERNS: readonly RegExp[] = [
  /(公式|提携|監修|公認|オフィシャル).{0,10}(として|のふり|を装|名乗|風|と書|と表示|にして|と偽)/,
  /(official|endorsed).{0,12}(pretend|as if|claim)/,
];

export function matchesAny(patterns: readonly RegExp[], value: string): boolean {
  const normalized = normalizeText(value);
  return patterns.some((pattern) => pattern.test(normalized));
}
