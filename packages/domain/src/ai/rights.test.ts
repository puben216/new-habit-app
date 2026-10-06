import { describe, expect, it } from "vitest";

import { evaluateRightsUse, type RightsRecord } from "./rights";

const NOW = new Date("2026-10-04T00:00:00Z");

const valid: RightsRecord = {
  sourceId: "src-fictional-1",
  origin: "internal-authored",
  rightsBasis: "自社作成",
  allowedUses: ["rag", "eval"],
  reviewedAt: new Date("2026-09-01T00:00:00Z"),
  expiresAt: new Date("2027-09-01T00:00:00Z"),
};

describe("evaluateRightsUse", () => {
  it("有効な記録と許可用途は allow", () => {
    expect(evaluateRightsUse(valid, "rag", NOW)).toEqual({ allowed: true });
  });

  it("記録がなければ deny", () => {
    expect(evaluateRightsUse(null, "rag", NOW)).toEqual({
      allowed: false,
      reason: "rights_record_missing",
    });
  });

  it("許可用途外は deny", () => {
    expect(evaluateRightsUse(valid, "few_shot", NOW)).toEqual({
      allowed: false,
      reason: "rights_use_not_allowed",
    });
  });

  it("期限切れは deny。ちょうど期限の瞬間も deny", () => {
    const expired = { ...valid, expiresAt: new Date("2026-10-03T23:59:59Z") };
    expect(evaluateRightsUse(expired, "rag", NOW)).toEqual({
      allowed: false,
      reason: "rights_expired",
    });
    const boundary = { ...valid, expiresAt: NOW };
    expect(evaluateRightsUse(boundary, "rag", NOW)).toEqual({
      allowed: false,
      reason: "rights_expired",
    });
  });

  it("必須項目の欠落・未来の review 日時・不正な日付は incomplete", () => {
    for (const broken of [
      { ...valid, origin: "  " },
      { ...valid, rightsBasis: "" },
      { ...valid, sourceId: "" },
      { ...valid, allowedUses: [] },
      { ...valid, reviewedAt: new Date("2026-12-01T00:00:00Z") },
      { ...valid, expiresAt: new Date("invalid") },
    ]) {
      expect(evaluateRightsUse(broken, "rag", NOW)).toEqual({
        allowed: false,
        reason: "rights_record_incomplete",
      });
    }
  });
});
