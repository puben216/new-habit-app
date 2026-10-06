import type { RightsRecord } from "@habit-app/domain";
import { describe, expect, it } from "vitest";

import { admitCorpusSource } from "./corpus";
import type { AiAuditEvent } from "./ports";

const NOW = new Date("2026-10-04T00:00:00Z");
const record: RightsRecord = {
  sourceId: "src-1",
  origin: "internal-authored",
  rightsBasis: "自社作成",
  allowedUses: ["rag"],
  reviewedAt: new Date("2026-09-01T00:00:00Z"),
  expiresAt: new Date("2027-01-01T00:00:00Z"),
};

function setup(records: RightsRecord[]) {
  const events: AiAuditEvent[] = [];
  const deps = {
    registry: { find: async (id: string) => records.find((r) => r.sourceId === id) ?? null },
    audit: { record: async (event: AiAuditEvent) => void events.push(event) },
    now: () => NOW,
  };
  return { deps, events };
}

describe("admitCorpusSource", () => {
  it("有効な記録と許可用途は admitted", async () => {
    const { deps, events } = setup([record]);
    await expect(admitCorpusSource(deps, { sourceId: "src-1", use: "rag" })).resolves.toEqual({
      admitted: true,
    });
    expect(events).toEqual([
      { kind: "corpus_admission", sourceId: "src-1", use: "rag", admitted: true, reason: null },
    ]);
  });

  it.each([
    ["未登録", [], "src-1", "rag", "rights_record_missing"],
    [
      "期限切れ",
      [{ ...record, expiresAt: new Date("2026-10-01T00:00:00Z") }],
      "src-1",
      "rag",
      "rights_expired",
    ],
    ["用途外", [record], "src-1", "few_shot", "rights_use_not_allowed"],
    ["根拠なし", [{ ...record, rightsBasis: "" }], "src-1", "rag", "rights_record_incomplete"],
  ] as const)(
    "%s は拒否し reason code を監査に残す",
    async (_label, records, sourceId, use, reason) => {
      const { deps, events } = setup([...records]);
      await expect(admitCorpusSource(deps, { sourceId, use })).resolves.toEqual({
        admitted: false,
        reason,
      });
      expect(events).toEqual([
        { kind: "corpus_admission", sourceId, use, admitted: false, reason },
      ]);
    },
  );
});
