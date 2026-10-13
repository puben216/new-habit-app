/**
 * アカウント削除の業務ルール(docs/specs/account-deletion.md、ADR-006)。
 * 期限は UTC の経過時間で決め、ローカル日付やタイムゾーンに依存しない(ACD-INV-001)。
 */

/** 削除予約から実際に削除されるまでの猶予期間(日)。この定数が唯一の定義(ADR-006)。 */
export const ACCOUNT_DELETION_GRACE_DAYS = 30;

/** 削除ジョブが 1 回の実行で処理する最大件数。 */
export const ACCOUNT_PURGE_BATCH_SIZE = 50;

const DAY_MS = 24 * 60 * 60 * 1000;

/** `users.status` の値域(DB の CHECK `users_status_check` と同じ)。 */
export const ACCOUNT_STATUSES = ["active", "suspended", "deletion_pending"] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export function isAccountStatus(value: unknown): value is AccountStatus {
  return typeof value === "string" && (ACCOUNT_STATUSES as readonly string[]).includes(value);
}

/** 猶予期間を過ぎる時刻(`deletedAt` の 30 日後)。この時刻を含めて「期限切れ」とする。 */
export function deletionDeadline(deletedAt: Date): Date {
  return new Date(deletedAt.getTime() + ACCOUNT_DELETION_GRACE_DAYS * DAY_MS);
}

/** 期限に達したか(`now >= deletedAt + 30 日`)。取り消しの可否と削除の対象判定が共有する。 */
export function isGracePeriodOver(deletedAt: Date, now: Date): boolean {
  return now.getTime() >= deletionDeadline(deletedAt).getTime();
}

/**
 * 削除ジョブの対象となる `deleted_at` の上限。`deleted_at <= cutoff` のユーザーが対象で、
 * `isGracePeriodOver(deletedAt, now)` と同値になる(DB の条件と Domain の判定を一致させる)。
 */
export function purgeCutoff(now: Date): Date {
  return new Date(now.getTime() - ACCOUNT_DELETION_GRACE_DAYS * DAY_MS);
}

/** 監査 action(ACD-INV-006)。要求・取り消しは利用者、削除はジョブ。内容や識別情報を含めない。 */
export const ACCOUNT_AUDIT_ACTIONS = [
  "user.account.deletion_requested",
  "user.account.deletion_cancelled",
  "system.account.purged",
] as const;
export type AccountAuditAction = (typeof ACCOUNT_AUDIT_ACTIONS)[number];

/** 監査ログの actor 表現。利用者は公開 ID、ジョブは固定文字列(個人情報を含めない)。 */
export function userAuditActor(userPublicId: string): string {
  return `user:${userPublicId}`;
}

export const SYSTEM_AUDIT_ACTOR = "system";
