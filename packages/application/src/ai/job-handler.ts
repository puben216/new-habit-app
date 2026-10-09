import { aiJobMessageV1Schema } from "@habit-app/contracts";

import { processAiJobUseCase } from "./job-use-cases";
import type { ProcessAiJobDeps } from "./job-use-cases";

/**
 * SQS event(ReportBatchItemFailures)形式の batch 処理(docs/specs/ai-queue-pipeline.md AJOB-004)。
 * Lambda の entry point(apps/workers)はこの関数へ委譲するだけの薄い adapter にする。
 * AWS の型に依存せず、必要な項目だけを構造的に受け取る。
 */

export interface AiJobQueueRecord {
  readonly messageId: string;
  readonly body: string;
  readonly attributes?: { readonly ApproximateReceiveCount?: string | undefined } | undefined;
}

export interface AiJobQueueBatch {
  readonly Records: readonly AiJobQueueRecord[];
}

export interface AiJobBatchResponse {
  readonly batchItemFailures: readonly { readonly itemIdentifier: string }[];
}

/** `ApproximateReceiveCount` は 1 始まり。欠落・不正は 1 として扱う(上限判定を早めない)。 */
function receiveCountOf(record: AiJobQueueRecord): number {
  const raw = record.attributes?.ApproximateReceiveCount;
  if (raw === undefined || !/^[1-9][0-9]{0,8}$/.test(raw)) return 1;
  return Number(raw);
}

function parseMessage(body: string): { readonly jobId: string } | null {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return null;
  }
  const parsed = aiJobMessageV1Schema.safeParse(json);
  return parsed.success ? { jobId: parsed.data.jobId } : null;
}

/**
 * batch を順に処理し、再配送が必要な record の `messageId` だけを返す。
 * 解釈できない message は再試行しても直らないため失敗として返し、queue の redrive で DLQ に移す。
 * 1 件の失敗・例外が他の record の処理を妨げない。
 */
export async function handleAiJobMessages(
  deps: ProcessAiJobDeps,
  batch: AiJobQueueBatch,
): Promise<AiJobBatchResponse> {
  const batchItemFailures: { itemIdentifier: string }[] = [];

  for (const record of batch.Records) {
    const message = parseMessage(record.body);
    if (message === null) {
      batchItemFailures.push({ itemIdentifier: record.messageId });
      continue;
    }
    try {
      const outcome = await processAiJobUseCase(deps, {
        jobId: message.jobId,
        receiveCount: receiveCountOf(record),
      });
      if (outcome === "retry") batchItemFailures.push({ itemIdentifier: record.messageId });
    } catch {
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
}
