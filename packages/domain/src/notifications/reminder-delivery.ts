/**
 * 配送の状態・定数・純粋な判定(docs/specs/notification-delivery.md)。
 * 定数は暫定値(NDL-INV-008)。確定・調整時はここだけを変更する。
 */

export const REMINDER_DELIVERY_STATUSES = [
  "pending",
  "sent",
  "skipped",
  "expired",
  "suppressed",
  "failed",
] as const;
export type ReminderDeliveryStatus = (typeof REMINDER_DELIVERY_STATUSES)[number];

/** 終端状態の行は二度と更新しない(NDL-INV-002)。 */
export function isTerminalDeliveryStatus(status: ReminderDeliveryStatus): boolean {
  return status !== "pending";
}

/** 送信枠から、この時間を過ぎた配送は送らず expired にする(分)。 */
export const REMINDER_MAX_LATENESS_MINUTES = 60;
/** 1 回の処理の lease(ミリ秒)。この間は他ワーカーが同じ配送を claim できない。 */
export const REMINDER_LEASE_MS = 5 * 60_000;
/** enqueue 済みの pending を再投入するまでの間隔(ミリ秒)。 */
export const REMINDER_REQUEUE_AFTER_MS = 10 * 60_000;
/** 1 配送あたりの最大試行回数(DB の CHECK と同値)。 */
export const REMINDER_MAX_ATTEMPTS = 5;
/** 再試行の待ち時間の基準と上限(ミリ秒)。 */
export const REMINDER_RETRY_BASE_MS = 60_000;
export const REMINDER_RETRY_MAX_MS = 15 * 60_000;
/** スケジューラが 1 回に読む設定の件数。 */
export const REMINDER_SCAN_PAGE_SIZE = 500;

/** 送信枠が許容遅延を過ぎているか。ちょうど許容遅延の時点は期限切れ(`[slot, slot + 許容遅延)` が有効)。 */
export function isReminderExpired(scheduledAt: Date, now: Date): boolean {
  return now.getTime() >= scheduledAt.getTime() + REMINDER_MAX_LATENESS_MINUTES * 60_000;
}

/** 送信枠に達しているか(`slot <= now`)。 */
export function isReminderDue(scheduledAt: Date, now: Date): boolean {
  return now.getTime() >= scheduledAt.getTime();
}

/**
 * 再試行までの待ち時間(ミリ秒)。`min(上限, 基準 × 2^(attempt-1))` に full jitter(0〜その値)をかける。
 * @param attempt 失敗した試行の通し番号(1 始まり)
 * @param random `[0, 1)` の乱数(テストで固定する)
 */
export function calculateRetryDelayMs(attempt: number, random: number): number {
  const exponent = Math.max(0, Math.min(attempt - 1, 30));
  const ceiling = Math.min(REMINDER_RETRY_MAX_MS, REMINDER_RETRY_BASE_MS * 2 ** exponent);
  return Math.floor(ceiling * Math.min(Math.max(random, 0), 0.999999));
}

/** 重複排除キー(NDL-INV-001)。設定の内部 ID とローカル日のみで決まる。 */
export function reminderDeduplicationKey(notificationSettingId: string, localDate: string): string {
  return `reminder:${notificationSettingId}:${localDate}`;
}
