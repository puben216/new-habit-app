import type { ReminderDeliveryStatus } from "@habit-app/domain";

/**
 * 通知の配送が依存する port 群(docs/plans/notification-delivery.md Interfaces and Contracts)。
 * AWS SDK など provider 固有の型をここへ漏らさない。
 */

/** スケジューラが走査する、有効なユーザー単位の設定。 */
export interface ReminderScanSetting {
  /** `notification_settings.id`(内部 ID。dedupe キーにのみ使う)。 */
  readonly settingId: string;
  readonly userId: string;
  readonly localTime: string;
  readonly timezone: string;
}

export interface ReminderDeliveryRecord {
  /** `notification_deliveries.id`(内部 ID)。queue message の唯一の内容。 */
  readonly id: string;
  readonly userId: string;
  readonly localDate: string;
  readonly scheduledAt: Date;
  readonly attemptCount: number;
}

export type FinalReminderStatus = Exclude<ReminderDeliveryStatus, "pending">;

export interface ReminderDeliveryRepositoryPort {
  /** 有効な設定を `settingId` の昇順で `afterSettingId` の次から最大 `limit` 件返す。 */
  listEnabledSettings(input: {
    readonly afterSettingId: string | null;
    readonly limit: number;
  }): Promise<readonly ReminderScanSetting[]>;

  /**
   * 送信予定を `pending` で作る。同じ `deduplicationKey` が既にあれば何もしない(`created: false`)。
   * 並行実行でも 1 行になる。
   */
  createPendingIfAbsent(input: {
    readonly setting: ReminderScanSetting;
    readonly localDate: string;
    readonly scheduledAt: Date;
    readonly deduplicationKey: string;
    readonly now: Date;
  }): Promise<{ readonly created: boolean }>;

  /** attempt が上限に達した pending(lease 切れ)を failed(`retries_exhausted`)にする。件数を返す。 */
  failExhausted(input: { readonly now: Date }): Promise<number>;

  /**
   * 投入すべき配送 ID: `pending` かつ `next_attempt_at <= now` かつ
   * (`enqueued_at IS NULL` または `enqueued_at < requeueBefore`)。`id` の昇順。
   */
  listEnqueueCandidates(input: {
    readonly now: Date;
    readonly requeueBefore: Date;
    readonly limit: number;
  }): Promise<readonly string[]>;

  markEnqueued(input: { readonly ids: readonly string[]; readonly now: Date }): Promise<void>;

  /**
   * 単一の条件付き UPDATE で配送を取得する。`pending` かつ `next_attempt_at <= now` かつ
   * lease が切れており、attempt が上限未満の場合のみ、`attempt_count + 1` と `locked_until` を設定して返す。
   * 取得できなければ `null`(終端済み・他ワーカーが処理中・まだ時刻でない)。
   */
  claim(input: {
    readonly deliveryId: string;
    readonly now: Date;
    readonly leaseUntil: Date;
  }): Promise<ReminderDeliveryRecord | null>;

  /** `pending` の行だけを終端状態にする(終端の行は更新しない。NDL-INV-002)。更新したら `true`。 */
  finalize(input: {
    readonly deliveryId: string;
    readonly status: FinalReminderStatus;
    readonly failureCode: string | null;
    readonly providerMessageId: string | null;
    readonly now: Date;
  }): Promise<boolean>;

  /** 一時的な失敗: `pending` のまま次回時刻を設定し lease を解除する。 */
  scheduleRetry(input: {
    readonly deliveryId: string;
    readonly nextAttemptAt: Date;
    readonly failureCode: string;
    readonly now: Date;
  }): Promise<void>;

  /** SES の message ID から配送のユーザー ID を引く。 */
  findUserIdByProviderMessageId(providerMessageId: string): Promise<string | null>;
}

/** 配送 ID だけを queue に載せる(NDL-INV-005)。投入に成功した ID を返す。 */
export interface ReminderQueuePort {
  enqueue(deliveryIds: readonly string[]): Promise<readonly string[]>;
}

export interface ReminderRecipient {
  readonly email: string;
  /** 配信停止 token の subject に使う公開 ID(内部 ID は使わない)。 */
  readonly userPublicId: string;
}

/** 送信直前にだけ宛先を取得する(NDL-INV-004)。email 未確認・削除済みなら `null`。 */
export interface RecipientPort {
  findRecipient(userId: string): Promise<ReminderRecipient | null>;
}

export interface EmailSuppressionPort {
  isSuppressed(userId: string): Promise<boolean>;
  /** 冪等に suppression を記録する(既にあれば何もしない)。 */
  suppress(input: {
    readonly userId: string;
    readonly reason: "bounce" | "complaint";
    readonly now: Date;
  }): Promise<void>;
}

export interface UnsubscribeTokenPort {
  issue(userPublicId: string): string;
  /** 署名・用途・形式が正しければ公開 ID、そうでなければ `null`。 */
  verify(token: string): string | null;
}

export type ReminderEmailErrorKind = "transient" | "permanent";

/** メール送信の失敗。メッセージにアドレスや provider の応答本文を含めない。 */
export class ReminderEmailError extends Error {
  readonly kind: ReminderEmailErrorKind;
  /** 運用で集計できる短い分類コード(例: `throttled`、`timeout`、`rejected`)。 */
  readonly code: string;

  constructor(kind: ReminderEmailErrorKind, code: string) {
    super(`reminder email ${kind}: ${code}`);
    this.name = "ReminderEmailError";
    this.kind = kind;
    this.code = code;
  }
}

export interface ReminderEmail {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  /** `List-Unsubscribe` / `List-Unsubscribe-Post` ヘッダーに使う配信停止 URL。 */
  readonly unsubscribeUrl: string;
}

export interface ReminderEmailPort {
  /** 成功時は provider の message ID を返す。失敗は `ReminderEmailError` を投げる。 */
  send(email: ReminderEmail): Promise<{ readonly providerMessageId: string }>;
}
