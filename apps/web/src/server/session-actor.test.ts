import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { ACCOUNT_STATUSES } from "@habit-app/domain";

import { accountSessionFromAuth, actorUserIdFromSession } from "./session-actor";

describe("actorUserIdFromSession(AUTH-009 / PROF-007)", () => {
  it("session.user.id が有効な文字列なら actor user ID を返す", () => {
    expect(
      actorUserIdFromSession({ user: { id: "42" }, expires: "2026-10-03T00:00:00.000Z" }),
    ).toBe("42");
  });

  it("session が無い・user が無い(期限切れ/失効)場合は未認証(null)", () => {
    expect(actorUserIdFromSession(null)).toBeNull();
    expect(actorUserIdFromSession(undefined)).toBeNull();
    expect(actorUserIdFromSession({ expires: "2026-10-03T00:00:00.000Z" })).toBeNull();
    expect(actorUserIdFromSession({ user: null })).toBeNull();
  });

  it("id が空・文字列以外なら未認証(null)", () => {
    expect(actorUserIdFromSession({ user: {} })).toBeNull();
    expect(actorUserIdFromSession({ user: { id: "" } })).toBeNull();
    expect(actorUserIdFromSession({ user: { id: 1 } })).toBeNull();
    expect(actorUserIdFromSession("session")).toBeNull();
  });
});

describe("削除予約中の session の遮断(ACD-INV-003)", () => {
  const session = (accountStatus: unknown) => ({ user: { id: "42" }, accountStatus });

  it("deletion_pending の session は Member 向けの actor を持たない", () => {
    expect(actorUserIdFromSession(session("deletion_pending"))).toBeNull();
  });

  it("active・suspended の session は従来どおり actor を持つ", () => {
    expect(actorUserIdFromSession(session("active"))).toBe("42");
    expect(actorUserIdFromSession(session("suspended"))).toBe("42");
  });

  it("性質: 他の項目(sessionId、mfaVerifiedAt など)があっても、deletion_pending なら常に null", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 10 }),
        fc.record({ sessionId: fc.string(), mfaVerifiedAt: fc.option(fc.string()) }),
        (id, extra) => {
          expect(
            actorUserIdFromSession({ user: { id }, accountStatus: "deletion_pending", ...extra }),
          ).toBeNull();
        },
      ),
    );
  });
});

describe("accountSessionFromAuth(状態の確認と取り消し用)", () => {
  it("削除予約中でも user ID と状態を返す", () => {
    for (const status of ACCOUNT_STATUSES) {
      expect(accountSessionFromAuth({ user: { id: "42" }, accountStatus: status })).toEqual({
        userId: "42",
        status,
      });
    }
  });

  it("未認証、状態の欠落・未知の値は認証済みとして扱わない(fail closed)", () => {
    expect(accountSessionFromAuth(null)).toBeNull();
    expect(accountSessionFromAuth({ expires: "x" })).toBeNull();
    expect(accountSessionFromAuth({ user: { id: "42" } })).toBeNull();
    expect(accountSessionFromAuth({ user: { id: "42" }, accountStatus: "deleted" })).toBeNull();
    expect(accountSessionFromAuth({ user: { id: "" }, accountStatus: "active" })).toBeNull();
  });
});
