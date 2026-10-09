import { z } from "zod";

/**
 * 通知の配送に関する契約(docs/specs/notification-delivery.md APIとイベント節)。
 * runtime schema を正本とし、型は z.infer で導出する(ADR-009)。
 */

/** 配信停止 token の最大長。署名つき token は約 150 文字。 */
export const UNSUBSCRIBE_TOKEN_MAX_LENGTH = 512;

/** `/api/v1/notification-unsubscribe` の query。 */
export const unsubscribeQuerySchema = z
  .object({ token: z.string().min(1).max(UNSUBSCRIBE_TOKEN_MAX_LENGTH) })
  .strict();
export type UnsubscribeQuery = z.infer<typeof unsubscribeQuerySchema>;

/** notifications queue の message。配送 ID のみを持つ(個人情報を載せない。NDL-INV-005)。 */
export const reminderQueueMessageSchema = z
  .object({
    version: z.literal(1),
    deliveryId: z.string().regex(/^[1-9][0-9]{0,18}$/),
  })
  .strict();
export type ReminderQueueMessage = z.infer<typeof reminderQueueMessageSchema>;

const messageIdSchema = z.string().min(1).max(256);

/**
 * SES の configuration set イベントのうち、判断に必要な項目だけを読む(未知のキーは許容)。
 * Delivery/Send など他の eventType は意図的に受理しない(呼び出し側が無視する)。
 */
export const sesFeedbackEventSchema = z.discriminatedUnion("eventType", [
  z.object({
    eventType: z.literal("Bounce"),
    mail: z.object({ messageId: messageIdSchema }),
    bounce: z.object({ bounceType: z.enum(["Permanent", "Transient", "Undetermined"]) }),
  }),
  z.object({
    eventType: z.literal("Complaint"),
    mail: z.object({ messageId: messageIdSchema }),
  }),
]);
export type SesFeedbackEvent = z.infer<typeof sesFeedbackEventSchema>;

/** SNS が SQS へ配信する通知の外側。`Message` に SES イベントの JSON 文字列が入る。 */
export const snsNotificationEnvelopeSchema = z.object({ Message: z.string().min(1) });
