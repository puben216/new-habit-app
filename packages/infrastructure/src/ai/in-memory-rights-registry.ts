import type { ThirdPartyRightsRegistryPort } from "@habit-app/application";
import type { RightsRecord } from "@habit-app/domain";

/**
 * 権利資料 registry の in-memory 実装(docs/specs/ai-contracts.md)。再起動で失われるため、
 * 永続化されるまで本番で RAG/few-shot の根拠として使わない。未登録は `null`(deny by default)。
 */
export function createInMemoryRightsRegistry(
  records: readonly RightsRecord[] = [],
): ThirdPartyRightsRegistryPort {
  const bySourceId = new Map(records.map((record) => [record.sourceId, record]));
  return {
    async find(sourceId) {
      return bySourceId.get(sourceId) ?? null;
    },
  };
}
