import { NotificationUserNotFoundError } from "@habit-app/application";
import type { NotificationSettingsView } from "@habit-app/application";
import { notificationSettingsResponseSchema } from "@habit-app/contracts";
import {
  InvalidNotificationPreferenceError,
  ReminderTimeInQuietHoursError,
} from "@habit-app/domain";
import { describe, expect, it, vi } from "vitest";

import { createNotificationSettingsHandlers } from "./notification-settings-handlers";
import type { NotificationSettingsUseCases } from "./notification-settings-handlers";

const ORIGIN = "https://app.example.test";
const NOW = new Date("2026-10-04T03:00:00.000Z");

const view: NotificationSettingsView = {
  enabled: true,
  localTime: "07:30",
  timezone: "Asia/Tokyo",
  quietHours: { start: "22:00", end: "07:00" },
  updatedAt: NOW,
};

function setup(options: { actor?: string | null } = {}) {
  const useCases = {
    get: vi.fn<NotificationSettingsUseCases["get"]>(async () => view),
    upsert: vi.fn<NotificationSettingsUseCases["upsert"]>(async () => view),
  };
  const handlers = createNotificationSettingsHandlers({
    allowedOrigin: ORIGIN,
    resolveActorUserId: async () => (options.actor === undefined ? "42" : options.actor),
    useCases,
  });
  return { handlers, useCases };
}

function getRequest(): Request {
  return new Request(`${ORIGIN}/api/v1/notification-settings`);
}

function putRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}/api/v1/notification-settings`, {
    method: "PUT",
    headers: { "content-type": "application/json", origin: ORIGIN, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function problem(response: Response) {
  return (await response.json()) as { code: string; fieldErrors?: Record<string, string[]> };
}

const valid = { enabled: true, localTime: "07:30" };

describe("GET /notification-settings", () => {
  it("200 で自分の設定を返し、内部 ID を含めない", async () => {
    const { handlers, useCases } = setup();
    const response = await handlers.get(getRequest());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = notificationSettingsResponseSchema.parse(await response.json());
    expect(body).toEqual({
      enabled: true,
      localTime: "07:30",
      timezone: "Asia/Tokyo",
      quietHours: { start: "22:00", end: "07:00" },
      updatedAt: NOW.toISOString(),
    });
    expect(useCases.get).toHaveBeenCalledWith({ actorUserId: "42" });
  });

  it("未保存の既定値は updatedAt: null で返る", async () => {
    const { handlers, useCases } = setup();
    useCases.get.mockResolvedValueOnce({
      ...view,
      enabled: false,
      quietHours: null,
      updatedAt: null,
    });
    const body = (await (await handlers.get(getRequest())).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ enabled: false, quietHours: null, updatedAt: null });
  });

  it("未認証は 401、user 不存在は 404", async () => {
    const unauth = setup({ actor: null });
    expect((await unauth.handlers.get(getRequest())).status).toBe(401);
    expect(unauth.useCases.get).not.toHaveBeenCalled();

    const missing = setup();
    missing.useCases.get.mockRejectedValueOnce(new NotificationUserNotFoundError());
    const response = await missing.handlers.get(getRequest());
    expect(response.status).toBe(404);
    expect((await problem(response)).code).toBe("user_not_found");
  });
});

describe("PUT /notification-settings", () => {
  it("200 で保存結果を返し、actor と body を use case へ渡す", async () => {
    const { handlers, useCases } = setup();
    const response = await handlers.upsert(
      putRequest({ ...valid, quietHours: null, timezone: "America/New_York" }),
    );
    expect(response.status).toBe(200);
    expect(useCases.upsert).toHaveBeenCalledWith({
      actorUserId: "42",
      enabled: true,
      localTime: "07:30",
      quietHours: null,
      timezone: "America/New_York",
    });
  });

  it("body で user・habit・channel を指定するキーは未知キーとして 422", async () => {
    const { handlers, useCases } = setup();
    for (const key of ["userId", "habitId", "channel"]) {
      const response = await handlers.upsert(putRequest({ ...valid, [key]: "7" }));
      expect(response.status).toBe(422);
    }
    expect(useCases.upsert).not.toHaveBeenCalled();
  });

  it("未認証は 401", async () => {
    const { handlers, useCases } = setup({ actor: null });
    expect((await handlers.upsert(putRequest(valid))).status).toBe(401);
    expect(useCases.upsert).not.toHaveBeenCalled();
  });

  it("Origin 不一致・欠落は 403、Origin なしでも same-origin なら許可", async () => {
    const { handlers, useCases } = setup();
    const bad = await handlers.upsert(putRequest(valid, { origin: "https://evil.example.test" }));
    expect(bad.status).toBe(403);
    expect((await problem(bad)).code).toBe("invalid_origin");

    const noOrigin = new Request(`${ORIGIN}/x`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(valid),
    });
    expect((await handlers.upsert(noOrigin)).status).toBe(403);

    const sameSite = new Request(`${ORIGIN}/x`, {
      method: "PUT",
      headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
      body: JSON.stringify(valid),
    });
    expect((await handlers.upsert(sameSite)).status).toBe(200);
    expect(useCases.upsert).toHaveBeenCalledTimes(1);
  });

  it("Content-Type が JSON でなければ 415、16 KiB 超は 413、JSON 不正は 422", async () => {
    const { handlers } = setup();
    const wrongType = await handlers.upsert(putRequest(valid, { "content-type": "text/plain" }));
    expect(wrongType.status).toBe(415);
    const tooLarge = await handlers.upsert(
      putRequest({ ...valid, timezone: "x".repeat(17 * 1024) }),
    );
    expect(tooLarge.status).toBe(413);
    expect((await handlers.upsert(putRequest("{not json"))).status).toBe(422);
  });

  it("schema 違反(時刻形式、必須欠落)は 422 validation_failed", async () => {
    const { handlers, useCases } = setup();
    for (const body of [
      { enabled: true, localTime: "7:30" },
      { enabled: true, localTime: "24:00" },
      { localTime: "07:30" },
      { enabled: true },
      { ...valid, quietHours: { start: "22:00" } },
    ]) {
      const response = await handlers.upsert(putRequest(body));
      expect(response.status).toBe(422);
      expect((await problem(response)).code).toBe("validation_failed");
    }
    expect(useCases.upsert).not.toHaveBeenCalled();
  });

  it.each([
    [new NotificationUserNotFoundError(), 404, "user_not_found"],
    [new ReminderTimeInQuietHoursError(), 422, "reminder_time_in_quiet_hours"],
    [
      new InvalidNotificationPreferenceError("timezone", "固定文言"),
      422,
      "invalid_notification_setting",
    ],
  ])("use case のエラー %# を HTTP %i / %s に変換する", async (error, status, code) => {
    const { handlers, useCases } = setup();
    useCases.upsert.mockRejectedValueOnce(error);
    const response = await handlers.upsert(putRequest(valid));
    expect(response.status).toBe(status);
    expect((await problem(response)).code).toBe(code);
  });

  it("InvalidNotificationPreferenceError は問題の項目名を fieldErrors に含める", async () => {
    const { handlers, useCases } = setup();
    useCases.upsert.mockRejectedValueOnce(
      new InvalidNotificationPreferenceError("quietHours", "固定文言"),
    );
    const response = await handlers.upsert(putRequest(valid));
    expect((await problem(response)).fieldErrors).toEqual({ quietHours: ["固定文言"] });
  });

  it("未知のエラーは再 throw し、応答に内部情報を含めない", async () => {
    const { handlers, useCases } = setup();
    useCases.upsert.mockRejectedValueOnce(new Error("connection string leaked"));
    await expect(handlers.upsert(putRequest(valid))).rejects.toThrow();
  });
});
