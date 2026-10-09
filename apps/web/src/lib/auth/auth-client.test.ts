import { describe, expect, it, vi } from "vitest";

import { ApiError, CLIENT_ERROR_CODES } from "@/lib/api/api-error";

import { signInWithPassword, signOut } from "./auth-client";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

interface Call {
  readonly path: string;
  readonly method: string | undefined;
  readonly body: string | undefined;
}

/** Auth.js の fake。`sessionUser` が null なら未ログインの session を返す。 */
function fakeAuth(options: {
  sessionUser: { id: string } | null;
  callbackStatus?: number;
  csrf?: unknown;
  sessionStatus?: number;
}) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const path = String(input);
    calls.push({ path, method: init?.method, body: init?.body as string | undefined });
    if (path === "/api/auth/csrf") return json(options.csrf ?? { csrfToken: "csrf-1" });
    if (path === "/api/auth/callback/credentials")
      return json({ url: "x" }, options.callbackStatus ?? 200);
    if (path === "/api/auth/session") {
      return json(
        options.sessionUser === null ? null : { user: options.sessionUser },
        options.sessionStatus ?? 200,
      );
    }
    if (path === "/api/auth/signout") return json({ url: "x" }, options.callbackStatus ?? 200);
    return json({}, 404);
  });
  return { fetchImpl, calls };
}

describe("signInWithPassword", () => {
  it("csrf 取得 → callback(form) → session 確認の順で呼び、user があれば success", async () => {
    const { fetchImpl, calls } = fakeAuth({ sessionUser: { id: "u1" } });

    const result = await signInWithPassword({
      email: "a@example.test",
      password: "pw & x=1",
      fetchImpl,
    });

    expect(result).toBe("success");
    expect(calls.map((c) => c.path)).toEqual([
      "/api/auth/csrf",
      "/api/auth/callback/credentials",
      "/api/auth/session",
    ]);
    const form = new URLSearchParams(calls[1]?.body);
    expect(form.get("csrfToken")).toBe("csrf-1");
    expect(form.get("email")).toBe("a@example.test");
    expect(form.get("password")).toBe("pw & x=1");
    expect(form.get("json")).toBe("true");
    expect(calls[1]?.method).toBe("POST");
  });

  it("session に user がなければ invalid_credentials(callback の status に依らない)", async () => {
    for (const callbackStatus of [200, 401, 500]) {
      const { fetchImpl } = fakeAuth({ sessionUser: null, callbackStatus });
      await expect(
        signInWithPassword({ email: "a@example.test", password: "x", fetchImpl }),
      ).resolves.toBe("invalid_credentials");
    }
  });

  it("session 応答が壊れている/非 200 でも invalid_credentials", async () => {
    const { fetchImpl } = fakeAuth({ sessionUser: { id: "u1" }, sessionStatus: 500 });
    await expect(signInWithPassword({ email: "a", password: "b", fetchImpl })).resolves.toBe(
      "invalid_credentials",
    );

    const broken = vi.fn<typeof fetch>(async (input) =>
      String(input) === "/api/auth/csrf"
        ? json({ csrfToken: "c" })
        : String(input) === "/api/auth/session"
          ? new Response("not json", { status: 200 })
          : json({}),
    );
    await expect(
      signInWithPassword({ email: "a", password: "b", fetchImpl: broken }),
    ).resolves.toBe("invalid_credentials");
  });

  it("session の user.id が空・欠落なら invalid_credentials", async () => {
    const empty = vi.fn<typeof fetch>(async (input) =>
      String(input) === "/api/auth/csrf"
        ? json({ csrfToken: "c" })
        : String(input) === "/api/auth/session"
          ? json({ user: {}, expires: "x" })
          : json({}),
    );
    await expect(signInWithPassword({ email: "a", password: "b", fetchImpl: empty })).resolves.toBe(
      "invalid_credentials",
    );
  });

  it("通信例外は network_error(認証失敗とは別。アカウントの状態に依存しない)", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new TypeError("secret-host refused");
    });

    const error = await signInWithPassword({ email: "a", password: "b", fetchImpl }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe(CLIENT_ERROR_CODES.networkError);
    expect((error as ApiError).message).not.toContain("secret-host");
  });

  it("csrf が取得できなければ unexpected_response(password を送らない)", async () => {
    const { fetchImpl, calls } = fakeAuth({ sessionUser: null, csrf: { nope: true } });

    const error = await signInWithPassword({ email: "a", password: "b", fetchImpl }).catch(
      (e: unknown) => e,
    );

    expect((error as ApiError).code).toBe(CLIENT_ERROR_CODES.unexpectedResponse);
    expect(calls.map((c) => c.path)).toEqual(["/api/auth/csrf"]);
  });
});

describe("signOut", () => {
  it("csrf 付きで signout を POST する", async () => {
    const { fetchImpl, calls } = fakeAuth({ sessionUser: null });

    await signOut({ fetchImpl });

    expect(calls.map((c) => c.path)).toEqual(["/api/auth/csrf", "/api/auth/signout"]);
    const form = new URLSearchParams(calls[1]?.body);
    expect(form.get("csrfToken")).toBe("csrf-1");
    expect(form.get("json")).toBe("true");
  });

  it("signout が失敗(非 2xx)したら ApiError を投げる", async () => {
    const { fetchImpl } = fakeAuth({ sessionUser: null, callbackStatus: 500 });
    await expect(signOut({ fetchImpl })).rejects.toBeInstanceOf(ApiError);
  });

  it("通信例外は network_error", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new TypeError("down");
    });
    const error = await signOut({ fetchImpl }).catch((e: unknown) => e);
    expect((error as ApiError).code).toBe(CLIENT_ERROR_CODES.networkError);
  });
});
