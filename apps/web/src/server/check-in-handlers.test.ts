import {
  CheckInDateOutOfRangeError,
  DailyCheckInNotFoundError,
  UserNotFoundError,
} from "@habit-app/application";
import type { DailyCheckInRecord } from "@habit-app/application";
import { dailyCheckInResponseSchema } from "@habit-app/contracts";
import { InvalidDailyCheckInError } from "@habit-app/domain";
import { describe, expect, it, vi } from "vitest";

import { createCheckInHandlers } from "./check-in-handlers";
import type { CheckInUseCases } from "./check-in-handlers";

const ORIGIN = "https://app.example.test";
const NOW = new Date("2026-01-14T03:00:00.000Z");

const record: DailyCheckInRecord = {
  date: "2026-01-14",
  mood: 4,
  difficulty: null,
  note: "歩いた",
  createdAt: NOW,
  updatedAt: NOW,
};

function setup(options: { actor?: string | null } = {}) {
  const useCases = {
    get: vi.fn<CheckInUseCases["get"]>(async () => record),
    upsert: vi.fn<CheckInUseCases["upsert"]>(async () => record),
  };
  const handlers = createCheckInHandlers({
    allowedOrigin: ORIGIN,
    resolveActorUserId: async () => (options.actor === undefined ? "42" : options.actor),
    useCases,
  });
  return { handlers, useCases };
}

const params = { date: "2026-01-14" };

function getRequest(): Request {
  return new Request(`${ORIGIN}/api/v1/daily-check-ins/2026-01-14`);
}

function putRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}/api/v1/daily-check-ins/2026-01-14`, {
    method: "PUT",
    headers: { "content-type": "application/json", origin: ORIGIN, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function problem(response: Response) {
  return (await response.json()) as { code: string; fieldErrors?: Record<string, string[]> };
}

describe("GET /daily-check-ins/{date}", () => {
  it("200 で自分のチェックインを返し、内部 ID を含めない", async () => {
    const { handlers, useCases } = setup();
    const response = await handlers.get(getRequest(), params);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(dailyCheckInResponseSchema.parse(await response.json())).toMatchObject({
      date: "2026-01-14",
      mood: 4,
      note: "歩いた",
    });
    expect(useCases.get).toHaveBeenCalledWith({ actorUserId: "42", date: "2026-01-14" });
  });

  it("未認証は 401、チェックインなしは 404、不正な日付は 422", async () => {
    const unauth = setup({ actor: null });
    expect((await unauth.handlers.get(getRequest(), params)).status).toBe(401);
    expect(unauth.useCases.get).not.toHaveBeenCalled();

    const missing = setup();
    missing.useCases.get.mockRejectedValueOnce(new DailyCheckInNotFoundError());
    const notFound = await missing.handlers.get(getRequest(), params);
    expect(notFound.status).toBe(404);
    expect((await problem(notFound)).code).toBe("check_in_not_found");

    const badDate = await missing.handlers.get(getRequest(), { date: "2026-02-30" });
    expect(badDate.status).toBe(422);
    expect((await problem(badDate)).fieldErrors).toHaveProperty("date");
  });
});

describe("PUT /daily-check-ins/{date}", () => {
  it("200 で保存結果を返し、actor・path・body を use case へ渡す", async () => {
    const { handlers, useCases } = setup();
    const response = await handlers.upsert(
      putRequest({ mood: 4, difficulty: 2, note: "歩いた" }),
      params,
    );
    expect(response.status).toBe(200);
    expect(useCases.upsert).toHaveBeenCalledWith({
      actorUserId: "42",
      date: "2026-01-14",
      mood: 4,
      difficulty: 2,
      note: "歩いた",
    });
  });

  it("body で user を指定するキーは未知キーとして 422", async () => {
    const { handlers, useCases } = setup();
    const response = await handlers.upsert(putRequest({ mood: 3, userId: "7" }), params);
    expect(response.status).toBe(422);
    expect(useCases.upsert).not.toHaveBeenCalled();
  });

  it("未認証は 401", async () => {
    const { handlers, useCases } = setup({ actor: null });
    expect((await handlers.upsert(putRequest({ mood: 3 }), params)).status).toBe(401);
    expect(useCases.upsert).not.toHaveBeenCalled();
  });

  it("Origin 不一致・欠落は 403、Origin なしでも same-origin なら許可", async () => {
    const { handlers, useCases } = setup();
    const bad = await handlers.upsert(
      putRequest({ mood: 3 }, { origin: "https://evil.example.test" }),
      params,
    );
    expect(bad.status).toBe(403);
    expect((await problem(bad)).code).toBe("invalid_origin");

    const noOrigin = new Request(`${ORIGIN}/x`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mood: 3 }),
    });
    expect((await handlers.upsert(noOrigin, params)).status).toBe(403);

    const sameSite = new Request(`${ORIGIN}/x`, {
      method: "PUT",
      headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ mood: 3 }),
    });
    expect((await handlers.upsert(sameSite, params)).status).toBe(200);
    expect(useCases.upsert).toHaveBeenCalledTimes(1);
  });

  it("Content-Type が JSON でなければ 415、16 KiB 超は 413、JSON 不正は 422", async () => {
    const { handlers } = setup();
    const wrongType = await handlers.upsert(
      putRequest({ mood: 3 }, { "content-type": "text/plain" }),
      params,
    );
    expect(wrongType.status).toBe(415);
    const tooLarge = await handlers.upsert(putRequest({ note: "x".repeat(17 * 1024) }), params);
    expect(tooLarge.status).toBe(413);
    expect((await handlers.upsert(putRequest("{not json"), params)).status).toBe(422);
  });

  it("schema 違反(値域外、メモの制御文字・長さ)は 422 validation_failed", async () => {
    const { handlers, useCases } = setup();
    for (const body of [
      { mood: 6 },
      { difficulty: 1.5 },
      { note: "a\u0000b" },
      { note: "あ".repeat(1001) },
    ]) {
      const response = await handlers.upsert(putRequest(body), params);
      expect(response.status).toBe(422);
      expect((await problem(response)).code).toBe("validation_failed");
    }
    expect(useCases.upsert).not.toHaveBeenCalled();
  });

  it("不正な date は 422(fieldErrors.date)で use case を呼ばない", async () => {
    const { handlers, useCases } = setup();
    const response = await handlers.upsert(putRequest({ mood: 3 }), { date: "2026-13-01" });
    expect(response.status).toBe(422);
    expect((await problem(response)).fieldErrors).toHaveProperty("date");
    expect(useCases.upsert).not.toHaveBeenCalled();
  });

  it.each([
    [new CheckInDateOutOfRangeError(), 422, "check_in_date_out_of_range"],
    [new UserNotFoundError(), 404, "user_not_found"],
    [new InvalidDailyCheckInError("check_in", "固定文言"), 422, "invalid_check_in"],
  ])("use case のエラー %# を HTTP %i / %s に変換する", async (error, status, code) => {
    const { handlers, useCases } = setup();
    useCases.upsert.mockRejectedValueOnce(error);
    const response = await handlers.upsert(putRequest({ mood: 3 }), params);
    expect(response.status).toBe(status);
    expect((await problem(response)).code).toBe(code);
  });

  it("InvalidDailyCheckInError は問題の項目名を fieldErrors に含める", async () => {
    const { handlers, useCases } = setup();
    useCases.upsert.mockRejectedValueOnce(new InvalidDailyCheckInError("mood", "固定文言"));
    const response = await handlers.upsert(putRequest({ mood: 3 }), params);
    expect((await problem(response)).fieldErrors).toEqual({ mood: ["固定文言"] });
  });

  it("未知のエラーは再 throw し、応答に内部情報を含めない", async () => {
    const { handlers, useCases } = setup();
    useCases.upsert.mockRejectedValueOnce(new Error("connection string leaked"));
    await expect(handlers.upsert(putRequest({ mood: 3 }), params)).rejects.toThrow();
  });
});
