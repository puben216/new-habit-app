import { describe, expect, it } from "vitest";
import { actorUserIdFromSession } from "./session-actor";

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
