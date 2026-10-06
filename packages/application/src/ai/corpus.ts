import { evaluateRightsUse, type RightsDenyReason, type RightsUse } from "@habit-app/domain";

import type { AiAuditSinkPort, ThirdPartyRightsRegistryPort } from "./ports";

export interface AdmitCorpusSourceDeps {
  readonly registry: ThirdPartyRightsRegistryPort;
  readonly audit: AiAuditSinkPort;
  readonly now: () => Date;
}

export type AdmitCorpusSourceResult =
  { readonly admitted: true } | { readonly admitted: false; readonly reason: RightsDenyReason };

/**
 * RAG/few-shot/eval への資料投入可否(docs/specs/ai-contracts.md AIC-006、IPG-001)。
 * 有効な rights record がなければ deny(deny by default)。監査には本文を渡さず sourceId と reason code のみ。
 */
export async function admitCorpusSource(
  deps: AdmitCorpusSourceDeps,
  input: { readonly sourceId: string; readonly use: RightsUse },
): Promise<AdmitCorpusSourceResult> {
  const record = await deps.registry.find(input.sourceId);
  const decision = evaluateRightsUse(record, input.use, deps.now());
  const result: AdmitCorpusSourceResult = decision.allowed
    ? { admitted: true }
    : { admitted: false, reason: decision.reason };
  await deps.audit.record({
    kind: "corpus_admission",
    sourceId: input.sourceId,
    use: input.use,
    admitted: decision.allowed,
    reason: decision.allowed ? null : decision.reason,
  });
  return result;
}
