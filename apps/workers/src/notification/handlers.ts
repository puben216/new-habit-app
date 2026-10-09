import {
  reminderQueueMessageSchema,
  sesFeedbackEventSchema,
  snsNotificationEnvelopeSchema,
} from "@habit-app/contracts";
import type {
  DeliverReminderOutcome,
  EmailFeedbackEvent,
  HandleEmailFeedbackOutcome,
  ScheduleDueRemindersSummary,
} from "@habit-app/application";

/**
 * 通知の Lambda handler 本体(docs/specs/notification-delivery.md)。
 * AWS・DB に依存しない純粋なロジックだけを持ち、use case は依存として受け取る。
 * `src/handlers/*` はこれらを組み立てて公開する薄い entry point。
 *
 * ログは件数のみ(個人情報・message の内容・例外メッセージを出さない)。
 */

export interface SqsRecord {
  readonly messageId: string;
  readonly body: string;
}

export interface SqsEvent {
  readonly Records: readonly SqsRecord[];
}

/** SQS の部分失敗応答(失敗した message だけを queue に残す)。 */
export interface SqsBatchResponse {
  readonly batchItemFailures: readonly { readonly itemIdentifier: string }[];
}

export type LogCounts = Readonly<Record<string, number | boolean | string>>;
export type Logger = (event: string, counts: LogCounts) => void;

/** 構造化ログ基盤が未導入のため、実行ごとに件数だけの 1 行 JSON を出す。 */
export const consoleLogger: Logger = (event, counts) => {
  console.log(JSON.stringify({ event, ...counts }));
};

export interface SchedulerHandlerDeps {
  readonly enabled: boolean;
  readonly run: () => Promise<ScheduleDueRemindersSummary>;
  readonly log: Logger;
}

/** EventBridge Scheduler から起動される。Feature Flag が無効なら何もしない。 */
export function createSchedulerHandler(deps: SchedulerHandlerDeps) {
  return async (): Promise<ScheduleDueRemindersSummary | { readonly disabled: true }> => {
    if (!deps.enabled) {
      deps.log("notification.scheduler", { disabled: true });
      return { disabled: true };
    }
    const summary = await deps.run();
    deps.log("notification.scheduler", { ...summary });
    return summary;
  };
}

export interface DeliveryHandlerDeps {
  readonly enabled: boolean;
  readonly deliver: (deliveryId: string) => Promise<DeliverReminderOutcome>;
  readonly log: Logger;
}

/**
 * notifications queue の consumer。
 * - 不正な message(JSON でない・schema 違反)は再処理しても直らないため、破棄して成功扱いにする(件数のみ記録)。
 * - 例外(DB 障害など)になった message だけを `batchItemFailures` で返し、SQS の redrive で DLQ へ移す。
 * - Feature Flag が無効の間は message を消費して何もしない。配送の行は `pending` のまま残り、
 *   有効化後にスケジューラが再投入する。
 */
export function createDeliveryHandler(deps: DeliveryHandlerDeps) {
  return async (event: SqsEvent): Promise<SqsBatchResponse> => {
    const failures: { itemIdentifier: string }[] = [];
    const counts: Record<string, number> = {
      received: event.Records.length,
      discarded: 0,
      errors: 0,
    };

    if (!deps.enabled) {
      deps.log("notification.delivery", { ...counts, disabled: true });
      return { batchItemFailures: [] };
    }

    for (const record of event.Records) {
      const message = parseQueueMessage(record.body);
      if (message === null) {
        counts["discarded"] = (counts["discarded"] ?? 0) + 1;
        continue;
      }
      try {
        const outcome = await deps.deliver(message.deliveryId);
        counts[outcome] = (counts[outcome] ?? 0) + 1;
      } catch {
        counts["errors"] = (counts["errors"] ?? 0) + 1;
        failures.push({ itemIdentifier: record.messageId });
      }
    }
    deps.log("notification.delivery", counts);
    return { batchItemFailures: failures };
  };
}

function parseQueueMessage(body: string): { readonly deliveryId: string } | null {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return null;
  }
  const parsed = reminderQueueMessageSchema.safeParse(json);
  return parsed.success ? { deliveryId: parsed.data.deliveryId } : null;
}

export interface FeedbackHandlerDeps {
  readonly handle: (event: EmailFeedbackEvent) => Promise<HandleEmailFeedbackOutcome>;
  readonly log: Logger;
}

/**
 * SES の bounce/complaint(SNS → SQS)の consumer。Feature Flag の影響を受けない
 * (送信を止めていても、すでに送った分のフィードバックは記録する)。
 * 対象外の eventType・不正な message は破棄して成功扱い、例外だけを部分失敗として返す。
 */
export function createFeedbackHandler(deps: FeedbackHandlerDeps) {
  return async (event: SqsEvent): Promise<SqsBatchResponse> => {
    const failures: { itemIdentifier: string }[] = [];
    const counts: Record<string, number> = {
      received: event.Records.length,
      discarded: 0,
      suppressed: 0,
      ignored: 0,
      errors: 0,
    };

    for (const record of event.Records) {
      const feedback = parseFeedback(record.body);
      if (feedback === null) {
        counts["discarded"] = (counts["discarded"] ?? 0) + 1;
        continue;
      }
      try {
        const outcome = await deps.handle(feedback);
        counts[outcome] = (counts[outcome] ?? 0) + 1;
      } catch {
        counts["errors"] = (counts["errors"] ?? 0) + 1;
        failures.push({ itemIdentifier: record.messageId });
      }
    }
    deps.log("notification.feedback", counts);
    return { batchItemFailures: failures };
  };
}

/** SNS の通知から SES イベントを取り出し、判断に必要な最小限の `EmailFeedbackEvent` にする。 */
export function parseFeedback(body: string): EmailFeedbackEvent | null {
  let envelopeJson: unknown;
  try {
    envelopeJson = JSON.parse(body);
  } catch {
    return null;
  }
  const envelope = snsNotificationEnvelopeSchema.safeParse(envelopeJson);
  if (!envelope.success) return null;

  let eventJson: unknown;
  try {
    eventJson = JSON.parse(envelope.data.Message);
  } catch {
    return null;
  }
  const parsed = sesFeedbackEventSchema.safeParse(eventJson);
  if (!parsed.success) return null;

  const providerMessageId = parsed.data.mail.messageId;
  if (parsed.data.eventType === "Complaint") return { kind: "complaint", providerMessageId };
  return parsed.data.bounce.bounceType === "Permanent"
    ? { kind: "bounce_permanent", providerMessageId }
    : { kind: "bounce_transient", providerMessageId };
}
