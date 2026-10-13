import {
  AccountNotActiveError,
  AccountNotFoundError,
  DeletionAlreadyRequestedError,
  DeletionNotRequestedError,
  GracePeriodExpiredError,
  ReauthenticationFailedError,
  TooManyAttemptsError,
} from "@habit-app/application";
import {
  accountDeletionCancelledResponseSchema,
  accountDeletionRequestedResponseSchema,
  accountDeletionStatusResponseSchema,
} from "@habit-app/contracts";
import { describe, expect, it, vi } from "vitest";

import { createAccountDeletionHandlers } from "./account-deletion-handlers";
import type { AccountDeletionUseCases } from "./account-deletion-handlers";
import type { AccountSessionInfo } from "./session-actor";

const ORIGIN = "https://app.example.test";
const DEADLINE = new Date("2026-11-11T03:00:00.000Z");

function setup(options: { actor?: string | null; account?: AccountSessionInfo | null } = {}) {
  const useCases = {
    request: vi.fn<AccountDeletionUseCases["request"]>(async () => ({
      status: "deletion_pending",
      scheduledFor: DEADLINE,
    })),
    cancel: vi.fn<AccountDeletionUseCases["cancel"]>(async () => ({ status: "active" })),
    status: vi.fn<AccountDeletionUseCases["status"]>(async () => ({
      status: "deletion_pending",
      scheduledFor: DEADLINE,
    })),
  };
  const hashIp = vi.fn((ip: string | null) => `hash(${ip ?? "none"})`);
  const handlers = createAccountDeletionHandlers({
    allowedOrigin: ORIGIN,
    resolveActorUserId: async () => (options.actor === undefined ? "42" : options.actor),
    resolveAccountSession: async () =>
      options.account === undefined
        ? { userId: "42", status: "deletion_pending" }
        : options.account,
    hashIp,
    newRequestId: () => "generated-request-id",
    useCases,
  });
  return { handlers, useCases, hashIp };
}

function deleteRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}/api/v1/me`, {
    method: "DELETE",
    headers: { "content-type": "application/json", origin: ORIGIN, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function postCancel(headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}/api/v1/me/deletion/cancel`, {
    method: "POST",
    headers: { origin: ORIGIN, ...headers },
  });
}

const getStatus = () => new Request(`${ORIGIN}/api/v1/me/deletion`);

async function problem(response: Response) {
  return (await response.json()) as { code: string };
}

describe("DELETE /me", () => {
  it("200 で期限を返し、actor・password・文脈(request ID、IP のハッシュ)を use case へ渡す", async () => {
    const { handlers, useCases } = setup();
    const response = await handlers.request(
      deleteRequest(
        { password: "pw" },
        { "x-request-id": "req-1", "x-forwarded-for": "203.0.113.9" },
      ),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(accountDeletionRequestedResponseSchema.parse(await response.json())).toEqual({
      status: "deletion_pending",
      scheduledFor: DEADLINE.toISOString(),
    });
    expect(useCases.request).toHaveBeenCalledWith({
      actorUserId: "42",
      password: "pw",
      context: { requestId: "req-1", ipHash: "hash(203.0.113.9)" },
    });
  });

  it("不正な request ID は採用せず生成する。生の IP は use case に渡さない", async () => {
    const { handlers, useCases } = setup();
    await handlers.request(deleteRequest({ password: "pw" }, { "x-request-id": "bad id!\n" }));
    const call = useCases.request.mock.calls[0]?.[0];
    expect(call?.context.requestId).toBe("generated-request-id");
    expect(JSON.stringify(call)).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
  });

  it("未認証(削除予約中の session を含む)は 401 で、use case を呼ばない", async () => {
    const { handlers, useCases } = setup({ actor: null });
    expect((await handlers.request(deleteRequest({ password: "pw" }))).status).toBe(401);
    expect(useCases.request).not.toHaveBeenCalled();
  });

  it("body で user を指定するキー・未知キーは 422", async () => {
    const { handlers, useCases } = setup();
    for (const key of ["userId", "email", "confirm"]) {
      const response = await handlers.request(deleteRequest({ password: "pw", [key]: "x" }));
      expect(response.status).toBe(422);
    }
    expect(useCases.request).not.toHaveBeenCalled();
  });

  it("password の欠落・空・文字列以外・128 文字超は 422 validation_failed", async () => {
    const { handlers, useCases } = setup();
    for (const body of [{}, { password: "" }, { password: 1 }, { password: "a".repeat(129) }]) {
      const response = await handlers.request(deleteRequest(body));
      expect(response.status).toBe(422);
      expect((await problem(response)).code).toBe("validation_failed");
    }
    expect(useCases.request).not.toHaveBeenCalled();
  });

  it("Origin 不一致・欠落は 403、Origin なしでも same-origin なら許可", async () => {
    const { handlers, useCases } = setup();
    const bad = await handlers.request(
      deleteRequest({ password: "pw" }, { origin: "https://evil.example.test" }),
    );
    expect(bad.status).toBe(403);
    expect((await problem(bad)).code).toBe("invalid_origin");

    const noOrigin = new Request(`${ORIGIN}/x`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "pw" }),
    });
    expect((await handlers.request(noOrigin)).status).toBe(403);

    const sameSite = new Request(`${ORIGIN}/x`, {
      method: "DELETE",
      headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ password: "pw" }),
    });
    expect((await handlers.request(sameSite)).status).toBe(200);
    expect(useCases.request).toHaveBeenCalledTimes(1);
  });

  it("Content-Type が JSON でなければ 415、1 KiB 超は 413、JSON 不正は 422", async () => {
    const { handlers } = setup();
    expect(
      (await handlers.request(deleteRequest({ password: "pw" }, { "content-type": "text/plain" })))
        .status,
    ).toBe(415);
    expect((await handlers.request(deleteRequest({ password: "a".repeat(2000) }))).status).toBe(
      413,
    );
    expect((await handlers.request(deleteRequest("{not json"))).status).toBe(422);
  });

  it.each([
    [new ReauthenticationFailedError(), 403, "reauthentication_failed"],
    [new TooManyAttemptsError(), 429, "too_many_attempts"],
    [new DeletionAlreadyRequestedError(), 409, "deletion_already_requested"],
    [new AccountNotActiveError(), 409, "account_not_active"],
    [new AccountNotFoundError(), 404, "user_not_found"],
  ])("use case のエラー %# を HTTP %i / %s に変換する", async (error, status, code) => {
    const { handlers, useCases } = setup();
    useCases.request.mockRejectedValueOnce(error);
    const response = await handlers.request(deleteRequest({ password: "pw" }));
    expect(response.status).toBe(status);
    expect((await problem(response)).code).toBe(code);
  });

  it("パスワードを応答に含めない。未知のエラーは再 throw する", async () => {
    const { handlers, useCases } = setup();
    useCases.request.mockRejectedValueOnce(new ReauthenticationFailedError());
    const response = await handlers.request(deleteRequest({ password: "super-secret-pw" }));
    expect(await response.text()).not.toContain("super-secret-pw");

    useCases.request.mockRejectedValueOnce(new Error("connection string leaked"));
    await expect(handlers.request(deleteRequest({ password: "pw" }))).rejects.toThrow();
  });
});

describe("削除予約中の session(Member 向けの actor を持たない)", () => {
  it("DELETE /me は 401 だが、状態の確認と取り消しは同じ session で使える", async () => {
    const { handlers, useCases } = setup({
      actor: null,
      account: { userId: "42", status: "deletion_pending" },
    });
    expect((await handlers.request(deleteRequest({ password: "pw" }))).status).toBe(401);
    expect((await handlers.status(getStatus())).status).toBe(200);
    expect((await handlers.cancel(postCancel())).status).toBe(200);
    expect(useCases.request).not.toHaveBeenCalled();
    expect(useCases.status).toHaveBeenCalledTimes(1);
    expect(useCases.cancel).toHaveBeenCalledTimes(1);
  });
});

describe("GET /me/deletion", () => {
  it("削除予約中の session でも 200 で状態と期限を返す", async () => {
    const { handlers, useCases } = setup();
    const response = await handlers.status(getStatus());
    expect(response.status).toBe(200);
    expect(accountDeletionStatusResponseSchema.parse(await response.json())).toEqual({
      status: "deletion_pending",
      scheduledFor: DEADLINE.toISOString(),
    });
    expect(useCases.status).toHaveBeenCalledWith({ actorUserId: "42" });
  });

  it("active は scheduledFor が null。未認証は 401、user 不存在は 404", async () => {
    const active = setup({ account: { userId: "42", status: "active" } });
    active.useCases.status.mockResolvedValueOnce({ status: "active", scheduledFor: null });
    expect(await (await active.handlers.status(getStatus())).json()).toEqual({
      status: "active",
      scheduledFor: null,
    });

    const unauth = setup({ account: null });
    expect((await unauth.handlers.status(getStatus())).status).toBe(401);
    expect(unauth.useCases.status).not.toHaveBeenCalled();

    const missing = setup();
    missing.useCases.status.mockRejectedValueOnce(new AccountNotFoundError());
    expect((await missing.handlers.status(getStatus())).status).toBe(404);
  });
});

describe("POST /me/deletion/cancel", () => {
  it("削除予約中の session で 200。actor は session から、文脈は request から渡す", async () => {
    const { handlers, useCases } = setup();
    const response = await handlers.cancel(postCancel({ "x-request-id": "req-2" }));
    expect(response.status).toBe(200);
    expect(accountDeletionCancelledResponseSchema.parse(await response.json())).toEqual({
      status: "active",
    });
    expect(useCases.cancel).toHaveBeenCalledWith({
      actorUserId: "42",
      context: { requestId: "req-2", ipHash: "hash(none)" },
    });
  });

  it("未認証は 401、Origin 不一致は 403(use case を呼ばない)", async () => {
    const unauth = setup({ account: null });
    expect((await unauth.handlers.cancel(postCancel())).status).toBe(401);
    const csrf = setup();
    expect(
      (await csrf.handlers.cancel(postCancel({ origin: "https://evil.example.test" }))).status,
    ).toBe(403);
    expect(unauth.useCases.cancel).not.toHaveBeenCalled();
    expect(csrf.useCases.cancel).not.toHaveBeenCalled();
  });

  it.each([
    [new DeletionNotRequestedError(), 409, "deletion_not_requested"],
    [new GracePeriodExpiredError(), 409, "grace_period_expired"],
    [new AccountNotFoundError(), 404, "user_not_found"],
  ])("use case のエラー %# を HTTP %i / %s に変換する", async (error, status, code) => {
    const { handlers, useCases } = setup();
    useCases.cancel.mockRejectedValueOnce(error);
    const response = await handlers.cancel(postCancel());
    expect(response.status).toBe(status);
    expect((await problem(response)).code).toBe(code);
  });
});
