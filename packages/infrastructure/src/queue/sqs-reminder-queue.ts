import { SQSClient, SendMessageBatchCommand } from "@aws-sdk/client-sqs";
import type { ReminderQueuePort } from "@habit-app/application";

/**
 * notifications queue への投入(docs/specs/notification-delivery.md NDL-002/NDL-INV-005)。
 *
 * - message は `{ version: 1, deliveryId }` のみ(個人情報を載せない)。
 * - SQS の 10 件/回の上限で分割し、投入に成功した ID だけを返す。呼び出し側(スケジューラ)は
 *   失敗した ID を次回の実行で再投入する。SDK 自身の再試行は無効(`maxAttempts: 1`)。
 * - 明示的な timeout を `AbortSignal` で課す。通信エラーはその batch の失敗として扱い、例外にしない
 *   (スケジューラの実行全体を止めない)。
 */

export const SQS_SEND_TIMEOUT_MS = 10_000;
const SQS_BATCH_SIZE = 10;

export interface SqsReminderQueueConfig {
  readonly client: SQSClient;
  readonly queueUrl: string;
  readonly timeoutMs?: number;
}

export function createSqsReminderQueue(config: SqsReminderQueueConfig): ReminderQueuePort {
  const timeoutMs = config.timeoutMs ?? SQS_SEND_TIMEOUT_MS;
  return {
    async enqueue(deliveryIds) {
      const accepted: string[] = [];
      for (let start = 0; start < deliveryIds.length; start += SQS_BATCH_SIZE) {
        const chunk = deliveryIds.slice(start, start + SQS_BATCH_SIZE);
        try {
          const result = await config.client.send(
            new SendMessageBatchCommand({
              QueueUrl: config.queueUrl,
              Entries: chunk.map((deliveryId, index) => ({
                Id: String(index),
                MessageBody: JSON.stringify({ version: 1, deliveryId }),
              })),
            }),
            { abortSignal: AbortSignal.timeout(timeoutMs) },
          );
          for (const entry of result.Successful ?? []) {
            const id = entry.Id === undefined ? undefined : chunk[Number(entry.Id)];
            if (id !== undefined) accepted.push(id);
          }
        } catch {
          // この batch は未投入として扱い、次の batch を試す。
        }
      }
      return accepted;
    },
  };
}

export function createSqsClient(options: {
  readonly region: string;
  readonly endpoint?: string;
  readonly credentials?: { readonly accessKeyId: string; readonly secretAccessKey: string };
}): SQSClient {
  return new SQSClient({
    region: options.region,
    maxAttempts: 1,
    ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
    ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
  });
}
