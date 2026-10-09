import { describe, expect, it, vi } from "vitest";

import { guardGuest } from "./session-guard";

class RedirectSignal extends Error {}
const redirectToApp = () => {
  const fn = vi.fn((): never => {
    throw new RedirectSignal();
  });
  return fn;
};

describe("guardGuest", () => {
  it("未認証なら何もしない(認証画面を表示する)", async () => {
    const redirect = redirectToApp();
    await expect(
      guardGuest({ getActorUserId: async () => null, redirectToApp: redirect }),
    ).resolves.toBeUndefined();
    expect(redirect).not.toHaveBeenCalled();
  });

  it("認証済みなら保護画面へ redirect する", async () => {
    const redirect = redirectToApp();
    await expect(
      guardGuest({ getActorUserId: async () => "user-1", redirectToApp: redirect }),
    ).rejects.toBeInstanceOf(RedirectSignal);
    expect(redirect).toHaveBeenCalledTimes(1);
  });

  it("session 取得の失敗は redirect せず伝播する", async () => {
    const redirect = redirectToApp();
    await expect(
      guardGuest({
        getActorUserId: async () => {
          throw new Error("db down");
        },
        redirectToApp: redirect,
      }),
    ).rejects.toThrow("db down");
    expect(redirect).not.toHaveBeenCalled();
  });
});
