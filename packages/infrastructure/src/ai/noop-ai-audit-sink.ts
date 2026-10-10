import type { AiAuditSinkPort } from "@habit-app/application";

/**
 * 何も記録しない監査 sink。構造化ログ・metric 基盤が未導入の間の配線用で、
 * 実 sink は T-501 の observability と合わせて実装する(docs/specs/ai-queue-pipeline.md)。
 * 監査イベントは本文を持たないため、記録しないことによる情報漏えいはない。
 */
export function createNoopAiAuditSink(): AiAuditSinkPort {
  return { async record() {} };
}
