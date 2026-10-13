import type {
  CleanupDataExportsSummary,
  DataExportBatchResponse,
  DataExportQueueBatch,
} from "@habit-app/application";

/**
 * データエクスポートの Lambda handler 本体(docs/specs/data-export.md EXP-002/007)。
 * AWS・DB に依存しない純粋なロジックだけを持ち、use case は依存として受け取る。
 *
 * ログは件数・状態のみ(データの内容・message の内容・例外メッセージを出さない)。
 */

export type LogCounts = Readonly<Record<string, number | boolean | string>>;
export type Logger = (event: string, counts: LogCounts) => void;

/** 構造化ログ基盤が未導入のため、実行ごとに件数だけの 1 行 JSON を出す。 */
export const consoleLogger: Logger = (event, counts) => {
  console.log(JSON.stringify({ event, ...counts }));
};

export interface ProcessHandlerDeps {
  readonly enabled: boolean;
  readonly handle: (batch: DataExportQueueBatch) => Promise<DataExportBatchResponse>;
  readonly log: Logger;
}

/**
 * export queue(SQS)の consumer。Feature Flag が無効なら何も処理せず、全 message を失敗として返して queue に
 * 残す(無効の間に届いた message を捨てない。有効化後に処理される)。
 */
export function createProcessHandler(deps: ProcessHandlerDeps) {
  return async (batch: DataExportQueueBatch): Promise<DataExportBatchResponse> => {
    if (!deps.enabled) {
      deps.log("export.process", { disabled: true, received: batch.Records.length });
      return {
        batchItemFailures: batch.Records.map((record) => ({ itemIdentifier: record.messageId })),
      };
    }
    const response = await deps.handle(batch);
    deps.log("export.process", {
      received: batch.Records.length,
      failed: response.batchItemFailures.length,
    });
    return response;
  };
}

export interface CleanupHandlerDeps {
  readonly enabled: boolean;
  readonly run: () => Promise<CleanupDataExportsSummary>;
  readonly log: Logger;
}

/** EventBridge Scheduler(日次)または手動実行で起動される。Feature Flag が無効なら DB に触れずに終了する。 */
export function createCleanupHandler(deps: CleanupHandlerDeps) {
  return async (): Promise<CleanupDataExportsSummary | { readonly disabled: true }> => {
    if (!deps.enabled) {
      deps.log("export.cleanup", { disabled: true });
      return { disabled: true };
    }
    const summary = await deps.run();
    deps.log("export.cleanup", { ...summary });
    return summary;
  };
}
