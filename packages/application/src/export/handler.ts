import { dataExportMessageV1Schema } from "@habit-app/contracts";

import { processDataExportUseCase } from "./use-cases";
import type { ProcessDataExportDeps } from "./use-cases";

/**
 * SQS event(ReportBatchItemFailures)形式の batch 処理(docs/specs/data-export.md EXP-002)。
 * Lambda の entry point(apps/workers)はこの関数へ委譲するだけの薄い adapter にする。
 */

export interface DataExportQueueRecord {
  readonly messageId: string;
  readonly body: string;
  readonly attributes?: { readonly ApproximateReceiveCount?: string | undefined } | undefined;
}

export interface DataExportQueueBatch {
  readonly Records: readonly DataExportQueueRecord[];
}

export interface DataExportBatchResponse {
  readonly batchItemFailures: readonly { readonly itemIdentifier: string }[];
}

/** `ApproximateReceiveCount` は 1 始まり。欠落・不正は 1 として扱う(上限判定を早めない)。 */
function receiveCountOf(record: DataExportQueueRecord): number {
  const raw = record.attributes?.ApproximateReceiveCount;
  if (raw === undefined || !/^[1-9][0-9]{0,8}$/.test(raw)) return 1;
  return Number(raw);
}

function parseMessage(body: string): { readonly exportId: string } | null {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return null;
  }
  const parsed = dataExportMessageV1Schema.safeParse(json);
  return parsed.success ? { exportId: parsed.data.exportId } : null;
}

/**
 * batch を順に処理し、再配送が必要な record の `messageId` だけを返す。
 * 解釈できない message は再試行しても直らないため失敗として返し、queue の redrive で DLQ に移す。
 * 1 件の失敗・例外が他の record の処理を妨げない。
 */
export async function handleDataExportMessages(
  deps: ProcessDataExportDeps,
  batch: DataExportQueueBatch,
): Promise<DataExportBatchResponse> {
  const batchItemFailures: { itemIdentifier: string }[] = [];
  for (const record of batch.Records) {
    const message = parseMessage(record.body);
    if (message === null) {
      batchItemFailures.push({ itemIdentifier: record.messageId });
      continue;
    }
    try {
      const outcome = await processDataExportUseCase(deps, {
        exportId: message.exportId,
        receiveCount: receiveCountOf(record),
      });
      if (outcome === "retry") batchItemFailures.push({ itemIdentifier: record.messageId });
    } catch {
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
}
