import {
  REMINDER_LEASE_MS,
  REMINDER_MAX_ATTEMPTS,
  calculateRetryDelayMs,
  isReminderExpired,
  isWithinQuietHours,
  localDateTimeAt,
} from "@habit-app/domain";

import type { Clock } from "../auth";
import type {
  EmailSuppressionPort,
  FinalReminderStatus,
  RecipientPort,
  ReminderDeliveryRepositoryPort,
  ReminderEmailPort,
  UnsubscribeTokenPort,
} from "./delivery-ports";
import { ReminderEmailError } from "./delivery-ports";
import type { NotificationSettingsRepositoryPort } from "./ports";
import { buildReminderEmail } from "./reminder-email";

export const UNSUBSCRIBE_PATH = "/api/v1/notification-unsubscribe";

export interface DeliverReminderDeps {
  readonly deliveryRepository: ReminderDeliveryRepositoryPort;
  readonly settingsRepository: NotificationSettingsRepositoryPort;
  readonly suppressions: EmailSuppressionPort;
  readonly recipients: RecipientPort;
  readonly emailSender: ReminderEmailPort;
  readonly unsubscribeTokens: UnsubscribeTokenPort;
  /** その日に予定された習慣のうち記録のないものがあるか(tracking の公開 API を束ねたもの)。 */
  readonly hasUnrecordedSchedule: (input: {
    readonly actorUserId: string;
    readonly date: string;
  }) => Promise<boolean>;
  /** `[0, 1)` の乱数(backoff の jitter。テストで固定する)。 */
  readonly random: () => number;
  readonly now: Clock;
  /** アプリの基点 URL(末尾スラッシュなし)。本文のリンクと配信停止 URL に使う。 */
  readonly appBaseUrl: string;
}

export type DeliverReminderOutcome = FinalReminderStatus | "retry" | "noop";

/**
 * 1 件の配送を処理する(NDL-003〜005)。終端状態の行は変更せず、重複 message・並行ワーカーは `noop`。
 * email は送信直前にだけ取得し、結果の記録・戻り値に含めない。
 *
 * 予期しない例外(DB 障害など)は握りつぶさず投げる。呼び出し側(Lambda)が失敗として message を残し、
 * SQS の redrive で DLQ へ移る。
 */
export async function deliverReminderUseCase(
  deps: DeliverReminderDeps,
  input: { readonly deliveryId: string },
): Promise<DeliverReminderOutcome> {
  const now = deps.now();
  const delivery = await deps.deliveryRepository.claim({
    deliveryId: input.deliveryId,
    now,
    leaseUntil: new Date(now.getTime() + REMINDER_LEASE_MS),
  });
  if (delivery === null) return "noop";

  const finish = async (
    status: FinalReminderStatus,
    failureCode: string | null,
    providerMessageId: string | null = null,
  ): Promise<DeliverReminderOutcome> => {
    // 終端済みの行は更新されない(false)。その場合も二重に処理していないので noop 扱い。
    const updated = await deps.deliveryRepository.finalize({
      deliveryId: delivery.id,
      status,
      failureCode,
      providerMessageId,
      now,
    });
    return updated ? status : "noop";
  };

  if (isReminderExpired(delivery.scheduledAt, now)) return finish("expired", null);

  const setting = await deps.settingsRepository.find({ actorUserId: delivery.userId });
  if (setting === null || !setting.enabled) return finish("skipped", "disabled");

  if (await deps.suppressions.isSuppressed(delivery.userId)) return finish("suppressed", null);

  if (setting.quietHours !== null) {
    const local = localDateTimeAt(now, setting.timezone);
    if (isWithinQuietHours(local.time, setting.quietHours)) return finish("expired", null);
  }

  const hasUnrecorded = await deps.hasUnrecordedSchedule({
    actorUserId: delivery.userId,
    date: delivery.localDate,
  });
  if (!hasUnrecorded) return finish("skipped", "already_recorded");

  const recipient = await deps.recipients.findRecipient(delivery.userId);
  if (recipient === null) return finish("failed", "no_recipient");

  const token = deps.unsubscribeTokens.issue(recipient.userPublicId);
  const unsubscribeUrl = `${deps.appBaseUrl}${UNSUBSCRIBE_PATH}?token=${encodeURIComponent(token)}`;
  const content = buildReminderEmail({ appUrl: deps.appBaseUrl, unsubscribeUrl });

  try {
    const sent = await deps.emailSender.send({
      to: recipient.email,
      subject: content.subject,
      text: content.text,
      unsubscribeUrl,
    });
    return await finish("sent", null, sent.providerMessageId);
  } catch (error) {
    if (!(error instanceof ReminderEmailError)) throw error;
    if (error.kind === "permanent") return finish("failed", error.code);
    if (delivery.attemptCount >= REMINDER_MAX_ATTEMPTS)
      return finish("failed", "retries_exhausted");
    await deps.deliveryRepository.scheduleRetry({
      deliveryId: delivery.id,
      nextAttemptAt: new Date(
        now.getTime() + calculateRetryDelayMs(delivery.attemptCount, deps.random()),
      ),
      failureCode: error.code,
      now,
    });
    return "retry";
  }
}
