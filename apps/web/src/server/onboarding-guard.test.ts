import { describe, expect, it, vi } from "vitest";

import { guardNotOnboarding, guardOnboarded } from "./onboarding-guard";

class RedirectSignal extends Error {}
const makeRedirect = () =>
  vi.fn((): never => {
    throw new RedirectSignal();
  });

describe("guardOnboarded", () => {
  it("未完了(displayName が null)なら redirect する", async () => {
    const redirect = makeRedirect();
    await expect(
      guardOnboarded({ getProfile: async () => ({ displayName: null }), redirect }),
    ).rejects.toBeInstanceOf(RedirectSignal);
  });

  it("完了済みなら何もしない", async () => {
    const redirect = makeRedirect();
    await guardOnboarded({ getProfile: async () => ({ displayName: "たなか" }), redirect });
    expect(redirect).not.toHaveBeenCalled();
  });

  it("プロフィール取得の失敗は redirect せず伝播する", async () => {
    const redirect = makeRedirect();
    await expect(
      guardOnboarded({
        getProfile: async () => {
          throw new Error("db down");
        },
        redirect,
      }),
    ).rejects.toThrow("db down");
    expect(redirect).not.toHaveBeenCalled();
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
