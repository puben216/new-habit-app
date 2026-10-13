import { DATA_EXPORT_MAX_RECEIVE } from "@habit-app/domain";
import type { DataExportQueuePort, ProcessDataExportOutcome } from "@habit-app/application";
import type { DataExportMessageV1 } from "@habit-app/contracts";

/**
 * ローカル/E2E 用の queue adapter(docs/specs/data-export.md)。同一プロセスで handler を非同期に呼ぶ。
 * SQS と同じく at-least-once で、`retry` なら `DATA_EXPORT_MAX_RECEIVE` 回まで受信回数を増やして再配送する。
 * 本番では使わない(`EXPORT_QUEUE_DRIVER=inline` は production で拒否される)。実 SQS adapter は T-501。
 */
export interface InlineDataExportQueue extends DataExportQueuePort {
  /** 投入済みのすべての message の処理が終わるまで待つ(テスト・E2E 用)。 */
  flush(): Promise<void>;
}

export type InlineDataExportHandler = (
  message: DataExportMessageV1,
  receiveCount: number,
) => Promise<ProcessDataExportOutcome>;

export function createInlineDataExportQueue(
  handler: InlineDataExportHandler,
): InlineDataExportQueue {
  const pending = new Set<Promise<void>>();

  async function deliver(message: DataExportMessageV1): Promise<void> {
    for (let receiveCount = 1; receiveCount <= DATA_EXPORT_MAX_RECEIVE; receiveCount += 1) {
      let outcome: ProcessDataExportOutcome;
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
      // 投入側(リクエスト)を待たせない。完了は flush で待てる。
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
