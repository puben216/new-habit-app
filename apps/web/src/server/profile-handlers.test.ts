import { getMyProfile, updateMyProfile } from "@habit-app/application";
import { describe, expect, it, vi } from "vitest";
import { createProfileHandlers } from "./profile-handlers";

import type { ProfileRecord, ProfileRepositoryPort } from "@habit-app/application";

const ORIGIN = "https://app.example.com";

interface FakeProfileRepository extends ProfileRepositoryPort {
  readonly profiles: Map<string, ProfileRecord>;
}

/** Route 層テスト専用の簡易 fake(Application の test-fakes は package 外へ公開しない)。 */
function createFakeProfileRepository(existingUserIds: readonly string[]): FakeProfileRepository {
  const profiles = new Map<string, ProfileRecord>();
  const updatedAt = new Date("2026-10-02T00:00:00.000Z");
  return {
    profiles,
    async ensure(userId, defaults) {
      if (!existingUserIds.includes(userId)) return null;
      const existing = profiles.get(userId);
      if (existing !== undefined) return existing;
      const created: ProfileRecord = { ...defaults, userId, updatedAt };
      profiles.set(userId, created);
      return created;
    },
    async update(userId, changes) {
      const existing = profiles.get(userId);
      if (existing === undefined) return null;
      const updated: ProfileRecord = { ...existing, ...changes, updatedAt };
      profiles.set(userId, updated);
      return updated;
    },
  };
}

function setup(options: { actorUserId?: string | null; existingUserIds?: string[] } = {}) {
  const actorUserId = options.actorUserId === undefined ? "1" : options.actorUserId;
  const profileRepository = createFakeProfileRepository(options.existingUserIds ?? ["1", "2"]);
  const logError = vi.fn();
  const handlers = createProfileHandlers({
    getActorUserId: async () => actorUserId,
    getMyProfile: (actor) => getMyProfile({ profileRepository }, actor),
    updateMyProfile: (actor, input) => updateMyProfile({ profileRepository }, actor, input),
    allowedOrigin: ORIGIN,
    logError,
  });
  return { handlers, profileRepository, logError };
}

function patchRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}/api/v1/me`, {
    method: "PATCH",
    headers: { "content-type": "application/json", origin: ORIGIN, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const getRequest = (): Request => new Request(`${ORIGIN}/api/v1/me`);

describe("GET /api/v1/me(PROF-001/007)", () => {
  it("未作成なら既定プロフィールを 200 で返す(内部IDを含めない)", async () => {
    const { handlers } = setup();

    const response = await handlers.GET(getRequest());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body).toEqual({
      displayName: null,
      timezone: "Asia/Tokyo",
      locale: "ja",
      weekStartsOn: 1,
      updatedAt: "2026-10-02T00:00:00.000Z",
    });
  });

  it("未認証は 401", async () => {
    const { handlers } = setup({ actorUserId: null });

    const response = await handlers.GET(getRequest());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: "unauthenticated" });
  });

  it("actor の user が存在しなければ 404", async () => {
    const { handlers } = setup({ existingUserIds: [] });

    const response = await handlers.GET(getRequest());

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: "not_found" });
  });

  it("想定外の例外は内部詳細を含まない 500 とし、error 名のみを log に出す", async () => {
    const logError = vi.fn();
    const handlers = createProfileHandlers({
      getActorUserId: async () => "1",
      getMyProfile: async () => {
        throw new Error("connection string postgres://secret@host");
      },
      updateMyProfile: async () => {
        throw new Error("unused");
      },
      allowedOrigin: ORIGIN,
      logError,
    });

    const response = await handlers.GET(getRequest());

    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain("secret");
    expect(JSON.stringify(logError.mock.calls)).not.toContain("secret");
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "internal_error", errorName: "Error" }),
    );
  });
});

describe("PATCH /api/v1/me(PROF-002〜005/007)", () => {
  it("指定項目のみ更新して 200 を返す", async () => {
    const { handlers } = setup();

    const response = await handlers.PATCH(
      patchRequest({ displayName: "たなか", timezone: "America/New_York" }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      displayName: "たなか",
      timezone: "America/New_York",
      locale: "ja",
      weekStartsOn: 1,
    });
  });

  it("Origin ヘッダが無い(非ブラウザ client)リクエストは許可する", async () => {
    const { handlers } = setup();
    const request = new Request(`${ORIGIN}/api/v1/me`, {
      method: "PATCH",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ locale: "en" }),
    });

    const response = await handlers.PATCH(request);

    expect(response.status).toBe(200);
  });

  it("未認証は 401(body の検証より先)", async () => {
    const { handlers } = setup({ actorUserId: null });

    const response = await handlers.PATCH(
      patchRequest("not json", { "content-type": "text/plain" }),
    );

    expect(response.status).toBe(401);
  });

  it("別 Origin からの PATCH は 403 で、プロフィールは変更されない", async () => {
    const { handlers, profileRepository } = setup();

    const response = await handlers.PATCH(
      patchRequest({ displayName: "attacker" }, { origin: "https://evil.example.net" }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "forbidden_origin" });
    expect(profileRepository.profiles.size).toBe(0);
  });

  it("Content-Type が application/json でなければ 415", async () => {
    const { handlers } = setup();

    const response = await handlers.PATCH(
      patchRequest(JSON.stringify({ locale: "en" }), { "content-type": "text/plain" }),
    );

    expect(response.status).toBe(415);
  });

  it("body が上限を超えれば 413(JSON parse 前に拒否)", async () => {
    const { handlers } = setup();

    const response = await handlers.PATCH(
      patchRequest(JSON.stringify({ displayName: "a".repeat(5000) })),
    );

    expect(response.status).toBe(413);
  });

  it("JSON でない body は 422", async () => {
    const { handlers } = setup();

    const response = await handlers.PATCH(patchRequest("{not json"));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ code: "invalid_request_body" });
  });

  it.each([
    ["空の body", {}],
    ["未知キー", { displayName: "a", status: "active" }],
    ["null", { displayName: null }],
    ["型違い", { weekStartsOn: "1" }],
    ["配列", []],
  ])("契約違反(%s)は 422 validation_failed", async (_label, body) => {
    const { handlers, profileRepository } = setup();

    const response = await handlers.PATCH(patchRequest(body));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ code: "validation_failed" });
    expect(profileRepository.profiles.size).toBe(0);
  });

  it("業務ルール違反は項目別の fieldErrors を返し、入力値を含めない", async () => {
    const { handlers, profileRepository } = setup();

    const response = await handlers.PATCH(
      patchRequest({ displayName: "x".repeat(51), timezone: "JST", locale: "fr", weekStartsOn: 9 }),
    );

    expect(response.status).toBe(422);
    const body = await response.json();
    expect(Object.keys(body.fieldErrors).sort()).toEqual([
      "displayName",
      "locale",
      "timezone",
      "weekStartsOn",
    ]);
    expect(JSON.stringify(body)).not.toContain("JST");
    expect(JSON.stringify(body)).not.toContain("x".repeat(51));
    expect(profileRepository.profiles.size).toBe(0);
  });

  it("actor の user が存在しなければ 404", async () => {
    const { handlers } = setup({ existingUserIds: [] });

    const response = await handlers.PATCH(patchRequest({ locale: "en" }));

    expect(response.status).toBe(404);
  });

  it("他ユーザーのプロフィールは変更されない(PROF-007)", async () => {
    const { handlers, profileRepository } = setup();
    await handlers.PATCH(patchRequest({ displayName: "ユーザー1" }));

    const other = createProfileHandlersFor("2", profileRepository);
    await other.PATCH(patchRequest({ displayName: "ユーザー2" }));

    expect(profileRepository.profiles.get("1")?.displayName).toBe("ユーザー1");
    expect(profileRepository.profiles.get("2")?.displayName).toBe("ユーザー2");
  });
});

function createProfileHandlersFor(actorUserId: string, profileRepository: FakeProfileRepository) {
  return createProfileHandlers({
    getActorUserId: async () => actorUserId,
    getMyProfile: (actor) => getMyProfile({ profileRepository }, actor),
    updateMyProfile: (actor, input) => updateMyProfile({ profileRepository }, actor, input),
    allowedOrigin: ORIGIN,
  });
}
