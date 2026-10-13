import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  ACCOUNT_DELETION_GRACE_DAYS,
  ACCOUNT_PURGE_BATCH_SIZE,
  deletionDeadline,
  isAccountStatus,
  isGracePeriodOver,
  purgeCutoff,
  userAuditActor,
} from "./deletion";

const DAY_MS = 24 * 60 * 60 * 1000;
const REQUESTED = new Date("2026-10-12T03:00:00.000Z");

describe("ACCOUNT_DELETION_GRACE_DAYS", () => {
  it("ADR-006 の 30 日", () => {
    expect(ACCOUNT_DELETION_GRACE_DAYS).toBe(30);
  });
});

describe("ACCOUNT_PURGE_BATCH_SIZE", () => {
  it("1 回の実行で処理する上限は 50 件(Spec ACD-006)", () => {
    expect(ACCOUNT_PURGE_BATCH_SIZE).toBe(50);
  });
});

describe("deletionDeadline / isGracePeriodOver", () => {
  it("期限は要求の 30 日後。ちょうどの時刻から期限切れになる(境界を含む)", () => {
    const deadline = deletionDeadline(REQUESTED);
    expect(deadline.toISOString()).toBe("2026-11-11T03:00:00.000Z");
    expect(isGracePeriodOver(REQUESTED, new Date(deadline.getTime() - 1))).toBe(false);
    expect(isGracePeriodOver(REQUESTED, deadline)).toBe(true);
    expect(isGracePeriodOver(REQUESTED, new Date(deadline.getTime() + 1))).toBe(true);
  });

  it("DST やローカル日付に依存しない(UTC の経過時間のみ)", () => {
    // 米国の DST 切り替え日をまたぐ要求でも、期限は常にちょうど 30 × 24 時間後。
    const beforeDst = new Date("2026-03-01T12:00:00.000Z");
    expect(deletionDeadline(beforeDst).getTime() - beforeDst.getTime()).toBe(30 * DAY_MS);
  });

  it("性質: 期限判定と削除対象のカットオフ判定は常に一致する", () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date("2020-01-01"), max: new Date("2100-01-01"), noInvalidDate: true }),
        fc.integer({ min: -3 * 30 * DAY_MS, max: 3 * 30 * DAY_MS }),
        (deletedAt, offset) => {
          const now = new Date(deletedAt.getTime() + 30 * DAY_MS + offset);
          // SQL の `deleted_at <= cutoff` と同じ判定。
          const dbCondition = deletedAt.getTime() <= purgeCutoff(now).getTime();
          expect(isGracePeriodOver(deletedAt, now)).toBe(dbCondition);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("性質: 要求から時間が経つほど期限切れ側に単調に移る", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100 * DAY_MS }),
        fc.integer({ min: 0, max: 100 * DAY_MS }),
        (a, b) => {
          const [early, late] = a <= b ? [a, b] : [b, a];
          const at = (offset: number) => new Date(REQUESTED.getTime() + offset);
          if (isGracePeriodOver(REQUESTED, at(early))) {
            expect(isGracePeriodOver(REQUESTED, at(late))).toBe(true);
          }
        },
      ),
    );
  });
});

describe("isAccountStatus", () => {
  it("DB の status の値域だけを通す", () => {
    for (const ok of ["active", "suspended", "deletion_pending"]) {
      expect(isAccountStatus(ok)).toBe(true);
    }
    for (const bad of ["deleted", "ACTIVE", "", null, undefined, 1]) {
      expect(isAccountStatus(bad)).toBe(false);
    }
  });
});

describe("userAuditActor", () => {
  it("公開 ID だけを含む", () => {
    expect(userAuditActor("11111111-2222-4333-8444-555555555555")).toBe(
      "user:11111111-2222-4333-8444-555555555555",
    );
  });
});
