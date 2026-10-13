import {
  AccountNotActiveError,
  AccountNotFoundError,
  ExportExpiredError,
  ExportInProgressError,
  ExportNotFoundError,
  ExportNotReadyError,
  ExportRateLimitedError,
  ExportUnavailableError,
  ReauthenticationFailedError,
  TooManyAttemptsError,
} from "@habit-app/application";
import type { DataExportRecord } from "@habit-app/application";
import { dataExportListResponseSchema, dataExportResponseSchema } from "@habit-app/contracts";
import { describe, expect, it, vi } from "vitest";

import { createDataExportHandlers } from "./data-export-handlers";
import type { DataExportUseCases } from "./data-export-handlers";

const ORIGIN = "https://app.example.test";
const ID = "11111111-2222-4333-8444-555555555555";
const CREATED = new Date("2026-10-13T03:00:00.000Z");
const EXPIRES = new Date("2026-10-14T03:00:12.000Z");

const queued: DataExportRecord = {
  id: ID,
  userId: "42",
  format: "json",
  status: "queued",
  failureCode: null,
  byteSize: null,
  fileName: null,
  contentType: null,
  createdAt: CREATED,
  completedAt: null,
  expiresAt: null,
};
const ready: DataExportRecord = {
  ...queued,
  status: "ready",
  byteSize: 1234,
  fileName: "habit-app-export-20261013.json",
  contentType: "application/json; charset=utf-8",
  completedAt: CREATED,
  expiresAt: EXPIRES,
};

function setup(options: { actor?: string | null } = {}) {
  const useCases = {
    request: vi.fn<DataExportUseCases["request"]>(async () => queued),
    list: vi.fn<DataExportUseCases["list"]>(async () => [ready, queued]),
    download: vi.fn<DataExportUseCases["download"]>(async () => ({
      fileName: "habit-app-export-20261013.json",
      contentType: "application/json; charset=utf-8",
      content: new TextEncoder().encode('{"ok":true}'),
    })),
  };
  const handlers = createDataExportHandlers({
    allowedOrigin: ORIGIN,
    resolveActorUserId: async () => (options.actor === undefined ? "42" : options.actor),
    hashIp: (ip) => `hash(${ip ?? "none"})`,
    newRequestId: () => "generated-request-id",
    useCases,
  });
  return { handlers, useCases };
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}/api/v1/me/exports`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
const get = (path = "/api/v1/me/exports") => new Request(`${ORIGIN}${path}`);
const valid = { password: "pw", format: "json" };

async function problem(response: Response) {
  return (await response.json()) as { code: string };
}

describe("POST /me/exports", () => {
  it("202 で queued のエクスポートを返し、actor・password・format・文脈を use case へ渡す", async () => {
    const { handlers, useCases } = setup();
    const response = await handlers.create(
      post(
        { ...valid, format: "csv" },
        { "x-request-id": "req-1", "x-forwarded-for": "203.0.113.9" },
      ),
    );
    expect(response.status).toBe(202);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(dataExportResponseSchema.parse(await response.json())).toEqual({
      id: ID,
      status: "queued",
      format: "json",
      requestedAt: CREATED.toISOString(),
      expiresAt: null,
      byteSize: null,
      failureCode: null,
    });
    expect(useCases.request).toHaveBeenCalledWith({
      actorUserId: "42",
      password: "pw",
      format: "csv",
      context: { requestId: "req-1", ipHash: "hash(203.0.113.9)" },
    });
  });

  it("不正な request ID は採用せず生成する。生の IP は use case に渡さない", async () => {
    const { handlers, useCases } = setup();
    await handlers.create(post(valid, { "x-request-id": "bad id!\n" }));
    const call = useCases.request.mock.calls[0]?.[0];
    expect(call?.context.requestId).toBe("generated-request-id");
    expect(JSON.stringify(call)).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
  });

  it("未認証(削除予約中の session を含む)は 401 で、use case を呼ばない", async () => {
    const { handlers, useCases } = setup({ actor: null });
    expect((await handlers.create(post(valid))).status).toBe(401);
    expect(useCases.request).not.toHaveBeenCalled();
  });

  it("body の検証: 未知キー・format 不正・password の空/型違い/上限超過は 422", async () => {
    const { handlers, useCases } = setup();
    for (const body of [
      { ...valid, userId: "7" },
      { ...valid, exportId: ID },
      { password: "pw", format: "xml" },
      { password: "pw" },
      { format: "json" },
      { password: "", format: "json" },
      { password: 1, format: "json" },
      { password: "a".repeat(129), format: "json" },
    ]) {
      const response = await handlers.create(post(body));
      expect(response.status, JSON.stringify(body)).toBe(422);
      expect((await problem(response)).code).toBe("validation_failed");
    }
    expect(useCases.request).not.toHaveBeenCalled();
  });

  it("Origin 不一致・欠落は 403、Origin なしでも same-origin なら許可", async () => {
    const { handlers, useCases } = setup();
    const bad = await handlers.create(post(valid, { origin: "https://evil.example.test" }));
    expect(bad.status).toBe(403);
    expect((await problem(bad)).code).toBe("invalid_origin");
    const noOrigin = new Request(`${ORIGIN}/x`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(valid),
    });
    expect((await handlers.create(noOrigin)).status).toBe(403);
    const sameSite = new Request(`${ORIGIN}/x`, {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
      body: JSON.stringify(valid),
    });
    expect((await handlers.create(sameSite)).status).toBe(202);
    expect(useCases.request).toHaveBeenCalledTimes(1);
  });

  it("Content-Type が JSON でなければ 415、1 KiB 超は 413、JSON 不正は 422", async () => {
    const { handlers } = setup();
    expect((await handlers.create(post(valid, { "content-type": "text/plain" }))).status).toBe(415);
    expect(
      (await handlers.create(post({ password: "a".repeat(2000), format: "json" }))).status,
    ).toBe(413);
    expect((await handlers.create(post("{not json"))).status).toBe(422);
  });

  it.each([
    [new ReauthenticationFailedError(), 403, "reauthentication_failed"],
    [new TooManyAttemptsError(), 429, "too_many_attempts"],
    [new ExportInProgressError(), 409, "export_in_progress"],
    [new ExportRateLimitedError(), 429, "export_rate_limited"],
    [new ExportUnavailableError(), 503, "export_unavailable"],
    [new AccountNotActiveError(), 409, "account_not_active"],
    [new AccountNotFoundError(), 404, "user_not_found"],
  ])("use case のエラー %# を HTTP %i / %s に変換する", async (error, status, code) => {
    const { handlers, useCases } = setup();
    useCases.request.mockRejectedValueOnce(error);
    const response = await handlers.create(post(valid));
    expect(response.status).toBe(status);
    expect((await problem(response)).code).toBe(code);
  });

  it("パスワードを応答に含めない。未知のエラーは再 throw する", async () => {
    const { handlers, useCases } = setup();
    useCases.request.mockRejectedValueOnce(new ReauthenticationFailedError());
    const response = await handlers.create(post({ password: "super-secret-pw", format: "json" }));
    expect(await response.text()).not.toContain("super-secret-pw");
    useCases.request.mockRejectedValueOnce(new Error("connection string leaked"));
    await expect(handlers.create(post(valid))).rejects.toThrow();
  });
});

describe("GET /me/exports", () => {
  it("200 で一覧を返し、内部 ID・user ID・ファイル名・成果物を含めない", async () => {
    const { handlers, useCases } = setup();
    const response = await handlers.list(get());
    expect(response.status).toBe(200);
    const body = dataExportListResponseSchema.parse(await response.json());
    expect(body.items).toHaveLength(2);
    expect(body.items[0]).toMatchObject({
      status: "ready",
      byteSize: 1234,
      expiresAt: EXPIRES.toISOString(),
    });
    const text = JSON.stringify(body);
    expect(text).not.toContain("userId");
    expect(text).not.toContain("fileName");
    expect(text).not.toContain("habit-app-export");
    expect(useCases.list).toHaveBeenCalledWith({ actorUserId: "42" });
  });

  it("未認証は 401", async () => {
    const { handlers, useCases } = setup({ actor: null });
    expect((await handlers.list(get())).status).toBe(401);
    expect(useCases.list).not.toHaveBeenCalled();
  });
});

describe("GET /me/exports/{id}/download", () => {
  it("200 でファイル本体を返し、添付・nosniff・no-store・固定のファイル名を付ける", async () => {
    const { handlers, useCases } = setup();
    const response = await handlers.download(get(`/api/v1/me/exports/${ID}/download`), {
      exportId: ID,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="habit-app-export-20261013.json"',
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-length")).toBe(String('{"ok":true}'.length));
    expect(await response.text()).toBe('{"ok":true}');
    expect(useCases.download).toHaveBeenCalledWith({
      actorUserId: "42",
      exportId: ID,
      context: { requestId: "generated-request-id", ipHash: "hash(none)" },
    });
  });

  it("未認証は 401(ファイルを読まない)", async () => {
    const { handlers, useCases } = setup({ actor: null });
    expect((await handlers.download(get(), { exportId: ID })).status).toBe(401);
    expect(useCases.download).not.toHaveBeenCalled();
  });

  it.each([
    [new ExportNotFoundError(), 404, "export_not_found"],
    [new ExportNotReadyError(), 409, "export_not_ready"],
    [new ExportExpiredError(), 410, "export_expired"],
  ])("use case のエラー %# を HTTP %i / %s に変換する", async (error, status, code) => {
    const { handlers, useCases } = setup();
    useCases.download.mockRejectedValueOnce(error);
    const response = await handlers.download(get(), { exportId: ID });
    expect(response.status).toBe(status);
    expect((await problem(response)).code).toBe(code);
    // エラーの応答にはファイルの添付ヘッダーを付けない。
    expect(response.headers.get("content-disposition")).toBeNull();
  });
});
