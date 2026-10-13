import { describe, expect, it, vi } from "vitest";

import { guardNotOnboarding, isOnboardingRequired } from "./onboarding-guard";

class RedirectSignal extends Error {}
const makeRedirect = () =>
  vi.fn((): never => {
    throw new RedirectSignal();
  });

describe("isOnboardingRequired", () => {
  it("未完了(displayName が null)なら true", async () => {
    await expect(
      isOnboardingRequired({ getProfile: async () => ({ displayName: null }) }),
    ).resolves.toBe(true);
  });

  it("完了済みなら false", async () => {
    await expect(
      isOnboardingRequired({ getProfile: async () => ({ displayName: "たなか" }) }),
    ).resolves.toBe(false);
  });

  it("プロフィール取得の失敗は伝播する(未完了とも完了済みとも扱わない)", async () => {
    await expect(
      isOnboardingRequired({
        getProfile: async () => {
          throw new Error("db down");
        },
      }),
    ).rejects.toThrow("db down");
  });
});

describe("guardNotOnboarding", () => {
  it("完了済みなら redirect する", async () => {
    const redirect = makeRedirect();
    await expect(
      guardNotOnboarding({ getProfile: async () => ({ displayName: "たなか" }), redirect }),
    ).rejects.toBeInstanceOf(RedirectSignal);
  });

  it("未完了なら何もしない", async () => {
    const redirect = makeRedirect();
    await guardNotOnboarding({ getProfile: async () => ({ displayName: null }), redirect });
    expect(redirect).not.toHaveBeenCalled();
  });
});
