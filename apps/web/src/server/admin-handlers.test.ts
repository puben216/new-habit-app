import type { AdminAccess } from "@habit-app/application";
import { describe, expect, it, vi } from "vitest";

import { createAdminHandlers } from "./admin-handlers";
import type { AdminHandlerDeps, AdminUseCases } from "./admin-handlers";
import type { AdminSessionInfo } from "./session-actor";

const ORIGIN = "https://app.example.test";
const NOW = new Date("2026-10-10T03:00:00.000Z");
const ADMIN = { adminId: "10", adminPublicId: "3f2b8c1e-5a47-4d9e-8c36-1b2a9e7d4f10" };
const USER_PUBLIC_ID = "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d";
const BASE = `${ORIGIN}/api/v1/admin`;

type Mode = "unauthenticated" | "member" | "mfa_required" | "granted";

function setup(mode: Mode) {
  const session: AdminSessionInfo | null =
    mode === "unauthenticated"
      ? null
      : { userId: "42", sessionId: "7", mfaVerifiedAt: mode === "granted" ? NOW : null };
  const access: AdminAccess =
    mode === "member"
      ? { status: "not_admin" }
      : mode === "granted"
        ? { status: "granted", admin: ADMIN, mfaExpiresAt: new Date(NOW.getTime() + 30 * 60_000) }
        : { status: "mfa_required", admin: ADMIN };

  const useCases = {
    verifyMfa: vi.fn<AdminUseCases["verifyMfa"]>(async () => ({ status: "verified" })),
    searchUser: vi.fn<AdminUseCases["searchUser"]>(async () => [
      {
        publicId: USER_PUBLIC_ID,
        emailMasked: "u***@example.test",
        status: "active",
        createdAt: NOW,
      },
    ]),
    getUserOverview: vi.fn<AdminUseCases["getUserOverview"]>(async () => ({
      publicId: USER_PUBLIC_ID,
      emailMasked: "u***@example.test",
      status: "active",
      createdAt: NOW,
      emailVerified: true,
      notification: { suppressed: false, deliveries: { failed: 1 } },
      aiJobs: {},
    })),
    listNotificationFailures: vi.fn<AdminUseCases["listNotificationFailures"]>(async () => ({
      items: [
        {
          id: "5",
          userPublicId: USER_PUBLIC_ID,
          status: "failed",
          failureCode: "rejected",
          attemptCount: 1,
          scheduledAt: NOW,
          localDate: "2026-10-10",
          updatedAt: NOW,
        },
      ],
      nextCursor: "5",
    })),
    listAiJobFailures: vi.fn<AdminUseCases["listAiJobFailures"]>(async () => ({
      items: [],
      nextCursor: null,
    })),
  };
  const authorize = vi.fn<AdminHandlerDeps["authorize"]>(async () => access);
  const hashIp = vi.fn((ip: string | null) => `hash(${ip ?? "unknown"})`);
  const handlers = createAdminHandlers({
    resolveSession: async () => session,
    authorize,
    allowedOrigin: ORIGIN,
    hashIp,
    newRequestId: () => "generated-request-id",
    now: () => NOW,
    useCases,
  });
  return { handlers, useCases, authorize, hashIp };
}

const get = (path: string, headers: Record<string, string> = {}) =>
  new Request(`${BASE}${path}`, { headers });
const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${BASE}/mfa/verify`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

async function problem(response: Response) {
  return (await response.json()) as {
    code: string;
    message: string;
    fieldErrors?: Record<string, string[]>;
  };
}

/** requestId(毎回変わる)以外が同一であることを比較するための要約。 */
async function summarize(response: Response) {
  const body = (await response.json()) as Record<string, unknown>;
  delete body["requestId"];
  const headers = [...response.headers.entries()]
    .filter(([name]) => name !== "content-length")
    .sort();
  return { status: response.status, body, headers };
}

const ALL_CALLS: [string, (h: ReturnType<typeof setup>["handlers"]) => Promise<Response>][] = [
  ["verify", (h) => h.verifyMfa(post({ code: "123456" }))],
  ["me", (h) => h.me(get("/me"))],
  ["search", (h) => h.searchUsers(get("/users?email=a@example.test"))],
  ["overview", (h) => h.getUser(get(`/users/${USER_PUBLIC_ID}`), { publicId: USER_PUBLIC_ID })],
  ["notifications", (h) => h.listNotificationFailures(get("/operations/notifications"))],
  ["ai-jobs", (h) => h.listAiJobFailures(get("/operations/ai-jobs"))],
  ["catch-all", (h) => h.notFound(get("/anything/else"))],
];

describe("認可の振り分け", () => {
  it("未認証はすべて 401(use case・認可を呼ばない)", async () => {
    for (const [, call] of ALL_CALLS) {
      const { handlers, authorize, useCases } = setup("unauthenticated");
      const response = await call(handlers);
      expect(response.status).toBe(401);
      expect((await problem(response)).code).toBe("unauthorized");
      expect(authorize).not.toHaveBeenCalled();
      for (const useCase of Object.values(useCases)) expect(useCase).not.toHaveBeenCalled();
    }
  });

  it("管理者でない Member はどの route でも 404 で、use case を呼ばない。本文・ヘッダーは route によらず同一", async () => {
    const summaries = [];
    for (const [, call] of ALL_CALLS) {
      const { handlers, useCases } = setup("member");
      const response = await call(handlers);
      expect(response.status).toBe(404);
      expect((await problem(response.clone())).code).toBe("not_found");
      expect(response.headers.get("x-robots-tag")).toBe("noindex");
      for (const useCase of Object.values(useCases)) expect(useCase).not.toHaveBeenCalled();
      summaries.push(await summarize(response));
    }
    for (const summary of summaries) expect(summary).toEqual(summaries[0]);
  });

  it("Member には、Origin 不正・Content-Type 違い・巨大 body・不正な入力でも 404(形式の検証結果を明かさない)", async () => {
    const { handlers, useCases } = setup("member");
    const bad = [
      await handlers.verifyMfa(post({ code: "123456" }, { origin: "https://evil.example.test" })),
      await handlers.verifyMfa(post({ code: "123456" }, { "content-type": "text/plain" })),
      await handlers.verifyMfa(post({ code: "x".repeat(5000) })),
      await handlers.verifyMfa(post("{not json")),
      await handlers.searchUsers(get("/users?email=not-an-email")),
      await handlers.getUser(get("/users/not-a-uuid"), { publicId: "not-a-uuid" }),
      await handlers.listNotificationFailures(get("/operations/notifications?limit=999")),
    ];
    for (const response of bad) expect(response.status).toBe(404);
    expect(useCases.verifyMfa).not.toHaveBeenCalled();
  });

  it("MFA 未検証の管理者: me と verify は使え、閲覧 API は 403 mfa_required", async () => {
    const { handlers, useCases } = setup("mfa_required");
    const me = await handlers.me(get("/me"));
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({
      adminPublicId: ADMIN.adminPublicId,
      mfaVerified: false,
      mfaExpiresAt: null,
    });
    expect((await handlers.verifyMfa(post({ code: "123456" }))).status).toBe(200);

    for (const call of [
      () => handlers.searchUsers(get("/users?email=a@example.test")),
      () => handlers.getUser(get(`/users/${USER_PUBLIC_ID}`), { publicId: USER_PUBLIC_ID }),
      () => handlers.listNotificationFailures(get("/operations/notifications")),
      () => handlers.listAiJobFailures(get("/operations/ai-jobs")),
    ]) {
      const response = await call();
      expect(response.status).toBe(403);
      expect((await problem(response)).code).toBe("mfa_required");
    }
    expect(useCases.searchUser).not.toHaveBeenCalled();
    expect(useCases.getUserOverview).not.toHaveBeenCalled();
    expect(useCases.listNotificationFailures).not.toHaveBeenCalled();
    expect(useCases.listAiJobFailures).not.toHaveBeenCalled();
  });

  it("検証済みの管理者の me は有効期限つき。管理者の判定は呼び出しごとに行う", async () => {
    const { handlers, authorize } = setup("granted");
    const me = await (await handlers.me(get("/me"))).json();
    expect(me).toEqual({
      adminPublicId: ADMIN.adminPublicId,
      mfaVerified: true,
      mfaExpiresAt: new Date(NOW.getTime() + 30 * 60_000).toISOString(),
    });
    await handlers.me(get("/me"));
    expect(authorize).toHaveBeenCalledTimes(2);
    expect(authorize).toHaveBeenCalledWith({ actorUserId: "42", mfaVerifiedAt: NOW });
  });

  it("catch-all: 管理者には 404(未認証 401 以外は存在する route と同じ応答)", async () => {
    const { handlers } = setup("granted");
    const response = await handlers.notFound(get("/unknown"));
    expect(response.status).toBe(404);
    expect((await problem(response)).code).toBe("not_found");
  });
});

describe("POST /admin/mfa/verify", () => {
  it("成功は 200 { status: verified }。actor・session・コード・文脈を use case へ渡す(body に user を指定する余地なし)", async () => {
    const { handlers, useCases } = setup("mfa_required");
    const response = await handlers.verifyMfa(
      post(
        { code: "123456" },
        { "x-request-id": "req-abc-123", "x-forwarded-for": "198.51.100.1, 203.0.113.9" },
      ),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "verified" });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(useCases.verifyMfa).toHaveBeenCalledWith({
      actorUserId: "42",
      sessionId: "7",
      code: "123456",
      context: { requestId: "req-abc-123", ipHash: "hash(203.0.113.9)" },
    });
    const rejected = await handlers.verifyMfa(post({ code: "123456", userId: "1" }));
    expect(rejected.status).toBe(422);
  });

  it("無効なコードは 403 invalid_mfa_code、ロックは 429 mfa_locked + Retry-After、管理者でなくなっていたら 404", async () => {
    const invalid = setup("mfa_required");
    invalid.useCases.verifyMfa.mockResolvedValueOnce({ status: "invalid" });
    const invalidResponse = await invalid.handlers.verifyMfa(post({ code: "000000" }));
    expect(invalidResponse.status).toBe(403);
    expect((await problem(invalidResponse)).code).toBe("invalid_mfa_code");

    const locked = setup("mfa_required");
    locked.useCases.verifyMfa.mockResolvedValueOnce({ status: "locked", retryAfterSeconds: 321 });
    const lockedResponse = await locked.handlers.verifyMfa(post({ code: "000000" }));
    expect(lockedResponse.status).toBe(429);
    expect(lockedResponse.headers.get("retry-after")).toBe("321");
    expect((await problem(lockedResponse)).code).toBe("mfa_locked");

    const gone = setup("mfa_required");
    gone.useCases.verifyMfa.mockResolvedValueOnce({ status: "not_admin" });
    expect((await gone.handlers.verifyMfa(post({ code: "123456" }))).status).toBe(404);
  });

  it("Origin 不一致は 403 invalid_origin、Content-Type 違いは 415、1 KiB 超は 413、JSON 不正・型違いは 422", async () => {
    const { handlers, useCases } = setup("mfa_required");
    const origin = await handlers.verifyMfa(
      post({ code: "1" }, { origin: "https://evil.example.test" }),
    );
    expect(origin.status).toBe(403);
    expect((await problem(origin)).code).toBe("invalid_origin");
    expect(
      (await handlers.verifyMfa(post({ code: "1" }, { "content-type": "text/plain" }))).status,
    ).toBe(415);
    expect((await handlers.verifyMfa(post({ code: "x".repeat(2000) }))).status).toBe(413);
    expect((await handlers.verifyMfa(post("{not json"))).status).toBe(422);
    expect((await handlers.verifyMfa(post({ code: 123456 }))).status).toBe(422);
    expect(useCases.verifyMfa).not.toHaveBeenCalled();
  });

  it("request ID が不正なら生成した値を使い、IP がなければ unknown を不可逆化する。生の IP を use case に渡さない", async () => {
    const { handlers, useCases, hashIp } = setup("mfa_required");
    await handlers.verifyMfa(post({ code: "123456" }, { "x-request-id": "bad id with spaces!" }));
    const call = useCases.verifyMfa.mock.calls[0]?.[0];
    expect(call?.context).toEqual({ requestId: "generated-request-id", ipHash: "hash(unknown)" });
    expect(hashIp).toHaveBeenCalledWith(null);
    expect(JSON.stringify(call)).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
  });

  it("use case の予期しない失敗(監査の追記失敗など)は握りつぶさず投げる", async () => {
    const { handlers, useCases } = setup("mfa_required");
    useCases.verifyMfa.mockRejectedValueOnce(new Error("audit store unavailable"));
    await expect(handlers.verifyMfa(post({ code: "123456" }))).rejects.toThrow();
  });
});

describe("閲覧 API(検証済みの管理者)", () => {
  it("検索: email を渡し、マスク済みの結果だけを返す。形式不正は 422", async () => {
    const { handlers, useCases } = setup("granted");
    const response = await handlers.searchUsers(get("/users?email=%20User%40Example.test%20"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      items: [
        {
          publicId: USER_PUBLIC_ID,
          emailMasked: "u***@example.test",
          status: "active",
          createdAt: NOW.toISOString(),
        },
      ],
    });
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
    expect(useCases.searchUser).toHaveBeenCalledWith({
      admin: ADMIN,
      context: { requestId: "generated-request-id", ipHash: "hash(unknown)" },
      email: "User@Example.test",
    });
    for (const query of ["", "?email=", "?email=user", "?email=a@example.test&x=1"]) {
      const bad = await handlers.searchUsers(get(`/users${query}`));
      expect(bad.status).toBe(422);
      expect((await problem(bad)).code).toBe("validation_failed");
    }
  });

  it("概要: 公開 ID が UUID でなければ 422、存在しなければ 404 user_not_found、あれば allowlist の項目だけ", async () => {
    const { handlers, useCases } = setup("granted");
    expect((await handlers.getUser(get("/users/42"), { publicId: "42" })).status).toBe(422);

    const ok = await handlers.getUser(get(`/users/${USER_PUBLIC_ID}`), {
      publicId: USER_PUBLIC_ID,
    });
    expect(ok.status).toBe(200);
    expect(Object.keys(await ok.json()).sort()).toEqual([
      "aiJobs",
      "createdAt",
      "emailMasked",
      "emailVerified",
      "notification",
      "publicId",
      "status",
    ]);

    useCases.getUserOverview.mockResolvedValueOnce(null);
    const missing = await handlers.getUser(get(`/users/${USER_PUBLIC_ID}`), {
      publicId: USER_PUBLIC_ID,
    });
    expect(missing.status).toBe(404);
    expect((await problem(missing)).code).toBe("user_not_found");
  });

  it("通知の失敗一覧: query を変換して渡し、項目は allowlist のみ。不正な query は 422", async () => {
    const { handlers, useCases } = setup("granted");
    const response = await handlers.listNotificationFailures(
      get("/operations/notifications?status=expired&limit=2&cursor=9"),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      items: Record<string, unknown>[];
      nextCursor: string;
    };
    expect(body.nextCursor).toBe("5");
    expect(Object.keys(body.items[0] ?? {}).sort()).toEqual([
      "attemptCount",
      "failureCode",
      "id",
      "localDate",
      "scheduledAt",
      "status",
      "updatedAt",
      "userPublicId",
    ]);
    expect(useCases.listNotificationFailures).toHaveBeenCalledWith({
      admin: ADMIN,
      context: { requestId: "generated-request-id", ipHash: "hash(unknown)" },
      statuses: ["expired"],
      limit: 2,
      cursor: "9",
    });
    for (const query of ["?limit=51", "?limit=0", "?status=sent", "?cursor=abc", "?foo=bar"]) {
      expect(
        (await handlers.listNotificationFailures(get(`/operations/notifications${query}`))).status,
      ).toBe(422);
    }
  });

  it("AI ジョブの失敗一覧: 空でも 200、status は failed/fallback のみ", async () => {
    const { handlers, useCases } = setup("granted");
    const response = await handlers.listAiJobFailures(get("/operations/ai-jobs"));
    expect(await response.json()).toEqual({ items: [], nextCursor: null });
    expect(useCases.listAiJobFailures).toHaveBeenCalledWith(
      expect.objectContaining({ statuses: undefined, cursor: null }),
    );
    expect(
      (await handlers.listAiJobFailures(get("/operations/ai-jobs?status=expired"))).status,
    ).toBe(422);
    expect(
      (await handlers.listAiJobFailures(get("/operations/ai-jobs?status=fallback"))).status,
    ).toBe(200);
  });

  it("use case の予期しない失敗(監査の追記失敗など)は閲覧結果を返さず投げる", async () => {
    const { handlers, useCases } = setup("granted");
    useCases.searchUser.mockRejectedValueOnce(new Error("audit store unavailable"));
    await expect(handlers.searchUsers(get("/users?email=a@example.test"))).rejects.toThrow();
  });
});
