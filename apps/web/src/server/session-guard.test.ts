import { describe, expect, it, vi } from "vitest";

import { guardSession } from "./session-guard";

class RedirectSignal extends Error {}

describe("guardSession", () => {
  it("有効な session なら user ID を返し、redirect しない", async () => {
    const redirectToLogin = vi.fn((): never => {
      throw new RedirectSignal();
    });

    const result = await guardSession({
      getActorUserId: async () => "user-1",
      redirectToLogin,
    });

    expect(result).toBe("user-1");
    expect(redirectToLogin).not.toHaveBeenCalled();
  });

  it("未認証なら redirect を呼び、user ID を返さない", async () => {
    const redirectToLogin = vi.fn((): never => {
      throw new RedirectSignal();
    });

    await expect(
      guardSession({ getActorUserId: async () => null, redirectToLogin }),
    ).rejects.toBeInstanceOf(RedirectSignal);
    expect(redirectToLogin).toHaveBeenCalledTimes(1);
  });

  it("session の取得が失敗した場合は redirect せず例外をそのまま伝える(認証済みとも扱わない)", async () => {
    const redirectToLogin = vi.fn((): never => {
      throw new RedirectSignal();
    });

    await expect(
      guardSession({
        getActorUserId: async () => {
          throw new Error("db down");
        },
        redirectToLogin,
      }),
    ).rejects.toThrow("db down");
    expect(redirectToLogin).not.toHaveBeenCalled();
  });
});
