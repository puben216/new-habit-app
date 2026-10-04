/**
 * AI/RAG/few-shot/eval に投入する第三者資料の権利判定(docs/specs/ai-contracts.md AIC-006)。
 * deny by default: 記録がない・必須項目が欠ける・期限切れ・許可用途外はすべて拒否する。
 */

export const RIGHTS_USES = ["rag", "few_shot", "eval"] as const;
export type RightsUse = (typeof RIGHTS_USES)[number];

export interface RightsRecord {
  readonly sourceId: string;
  /** 取得元(URL や提供元の識別。本文は含めない)。 */
  readonly origin: string;
  /** 権利根拠(契約・ライセンス名・自社著作など)。 */
  readonly rightsBasis: string;
  readonly allowedUses: readonly RightsUse[];
  readonly reviewedAt: Date;
  readonly expiresAt: Date;
}

export const RIGHTS_DENY_REASONS = [
  "rights_record_missing",
  "rights_record_incomplete",
  "rights_expired",
  "rights_use_not_allowed",
] as const;
export type RightsDenyReason = (typeof RIGHTS_DENY_REASONS)[number];

export type RightsDecision =
  { readonly allowed: true } | { readonly allowed: false; readonly reason: RightsDenyReason };

function isBlank(value: string): boolean {
  return value.trim().length === 0;
}

function isValidDate(value: Date): boolean {
  return !Number.isNaN(value.getTime());
}

/** 期限は `expiresAt <= now` で切れとみなす(境界は deny 側)。 */
export function evaluateRightsUse(
  record: RightsRecord | null,
  use: RightsUse,
  now: Date,
): RightsDecision {
  if (record === null) return { allowed: false, reason: "rights_record_missing" };
  if (
    isBlank(record.sourceId) ||
    isBlank(record.origin) ||
    isBlank(record.rightsBasis) ||
    record.allowedUses.length === 0 ||
    !isValidDate(record.reviewedAt) ||
    !isValidDate(record.expiresAt) ||
    record.reviewedAt.getTime() > now.getTime()
  ) {
    return { allowed: false, reason: "rights_record_incomplete" };
  }
  if (record.expiresAt.getTime() <= now.getTime()) {
    return { allowed: false, reason: "rights_expired" };
  }
  if (!record.allowedUses.includes(use)) {
    return { allowed: false, reason: "rights_use_not_allowed" };
  }
  return { allowed: true };
}
