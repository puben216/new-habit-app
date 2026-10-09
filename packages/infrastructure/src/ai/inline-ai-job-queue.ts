import { AI_JOB_MAX_RECEIVE } from "@habit-app/application";
import type { AiJobQueuePort, ProcessAiJobOutcome } from "@habit-app/application";
import type { AiJobMessageV1 } from "@habit-app/contracts";

/**
 * ローカル/E2E 用の queue adapter(docs/specs/ai-queue-pipeline.md)。同一プロセスで handler を非同期に呼ぶ。
 * SQS と同じく at-least-once で、`retry` なら `AI_JOB_MAX_RECEIVE` 回まで受信回数を増やして再配送する。
 * 本番では使わない(`AI_QUEUE_DRIVER=inline` は production で拒否される)。実 SQS adapter は T-501。
 */
export interface InlineAiJobQueue extends AiJobQueuePort {
  /** 投入済みのすべての message の処理が終わるまで待つ(テスト・E2E 用)。 */
  flush(): Promise<void>;
}

export type InlineAiJobHandler = (
  message: AiJobMessageV1,
  receiveCount: number,
) => Promise<ProcessAiJobOutcome>;

export function createInlineAiJobQueue(handler: InlineAiJobHandler): InlineAiJobQueue {
  const pending = new Set<Promise<void>>();

  async function deliver(message: AiJobMessageV1): Promise<void> {
    for (let receiveCount = 1; receiveCount <= AI_JOB_MAX_RECEIVE; receiveCount += 1) {
      let outcome: ProcessAiJobOutcome;
      try {
        outcome = await handler(message, receiveCount);
      } catch {
        outcome = "retry";
      }
      if (outcome === "done") return;
    }
  }

  return {
    async enqueue(message) {
      // 投入側を待たせない(非同期)。完了は flush で待てる。
      const task = new Promise<void>((resolve) => setTimeout(resolve, 0))
        .then(() => deliver(message))
        .finally(() => pending.delete(task));
      pending.add(task);
    },
    async flush() {
      while (pending.size > 0) await Promise.all([...pending]);
    },
  };
}
