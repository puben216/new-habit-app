import { handleAiJobMessages } from "@habit-app/application";
import type { AiJobBatchResponse, AiJobQueueBatch, ProcessAiJobDeps } from "@habit-app/application";

/**
 * `ai-coaching` queue(SQS)の handler 本体(docs/specs/ai-queue-pipeline.md)。
 * 業務ロジックは持たず、SQS event を `handleAiJobMessages` へ渡して `batchItemFailures` を返すだけ
 * (ReportBatchItemFailures)。依存は呼び出しごとに取得する(コールドスタート時の遅延構築)。
 */
export function createAiCoachingHandler(
  getDeps: () => Promise<ProcessAiJobDeps>,
): (event: AiJobQueueBatch) => Promise<AiJobBatchResponse> {
  return async (event) => handleAiJobMessages(await getDeps(), event);
}
