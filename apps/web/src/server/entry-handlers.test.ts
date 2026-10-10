import {
  EntryDateOutOfRangeError,
  HabitNotFoundError,
  HabitNotScheduledError,
} from "@habit-app/application";
import type { HabitEntryRecord, TodaySchedule } from "@habit-app/application";
import { habitEntryResponseSchema, todayScheduleResponseSchema } from "@habit-app/contracts";
import { HabitArchivedError, InvalidHabitEntryError, createHabit } from "@habit-app/domain";
import { describe, expect, it, vi } from "vitest";

import { createEntryHandlers } from "./entry-handlers";
import type { EntryUseCases } from "./entry-handlers";

const ORIGIN = "https://app.example.test";
const HABIT_ID = "5d1b6d4e-6b1c-4a0e-9e0e-7a0f8d5b8c11";
const NOW = new Date("2026-01-14T03:00:00.000Z");

const entry: HabitEntryRecord = {
  habitId: HABIT_ID,
  date: "2026-01-14",
  status: "success",
  quantity: 1,
  createdAt: NOW,
  updatedAt: NOW,
};

const habit = createHabit({
  id: HABIT_ID,
  kind: "build",
  name: "水を飲む",
  purpose: "健康維持",
  cue: "起床直後",
  minimumAction: "コップ1杯",
  initialSchedule: {
    effectiveFrom: "2025-01-01",
    daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
    targetCount: 1,
  },
});

const todaySchedule: TodaySchedule = {
  date: "2026-01-14",
  timezone: "Asia/Tokyo",
  earliestDate: "2026-01-07",
  items: [{ habit, targetCount: 1, entry }],
};

function setup(options: { actor?: string | null } = {}) {
  const useCases = {
    getToday: vi.fn<EntryUseCases["getToday"]>(async () => todaySchedule),
    getOnDate: vi.fn<EntryUseCases["getOnDate"]>(async () => todaySchedule),
    upsert: vi.fn<EntryUseCases["upsert"]>(async () => entry),
  };
  const handlers = createEntryHandlers({
    allowedOrigin: ORIGIN,
    resolveActorUserId: async () => (options.actor === undefined ? "42" : options.actor),
    useCases,
  });
  return { handlers, useCases };
}

const params = { habitId: HABIT_ID, date: "2026-01-14" };

function putRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}/api/v1/habits/${HABIT_ID}/entries/2026-01-14`, {
    method: "PUT",
    headers: { "content-type": "application/json", origin: ORIGIN, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function problem(response: Response) {
  return (await response.json()) as { code: string; fieldErrors?: Record<string, string[]> };
}

describe("GET /schedule/today", () => {
  it("200 で今日の予定を返し、内部 ID を含めない", async () => {
    const { handlers, useCases } = setup();
    const response = await handlers.today(new Request(`${ORIGIN}/api/v1/schedule/today`));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = todayScheduleResponseSchema.parse(await response.json());
    expect(body).toMatchObject({ date: "2026-01-14", timezone: "Asia/Tokyo" });
    expect(body.items[0]?.entry).toMatchObject({ status: "success", quantity: 1 });
    expect(useCases.getToday).toHaveBeenCalledWith({ actorUserId: "42" });
    expect(JSON.stringify(body)).not.toContain("userId");
  });

  it("未認証は 401 で use case を呼ばない", async () => {
    const { handlers, useCases } = setup({ actor: null });
    const response = await handlers.today(new Request(`${ORIGIN}/api/v1/schedule/today`));
    expect(response.status).toBe(401);
    expect(useCases.getToday).not.toHaveBeenCalled();
  });
});

describe("PUT /habits/{habitId}/entries/{date}", () => {
  it("200 で保存結果を返し、actor・path・body を use case へ渡す", async () => {
    const { handlers, useCases } = setup();
    const response = await handlers.upsert(putRequest({ status: "missed", quantity: 2 }), params);
    expect(response.status).toBe(200);
    expect(habitEntryResponseSchema.parse(await response.json())).toMatchObject({
      habitId: HABIT_ID,
      date: "2026-01-14",
    });
    expect(useCases.upsert).toHaveBeenCalledWith({
      actorUserId: "42",
      habitId: HABIT_ID,
      date: "2026-01-14",
      status: "missed",
      quantity: 2,
    });
  });

  it("body の userId など actor を上書きしようとするキーは 422(未知キー)", async () => {
    const { handlers, useCases } = setup();
    const response = await handlers.upsert(putRequest({ status: "success", userId: "7" }), params);
    expect(response.status).toBe(422);
    expect(useCases.upsert).not.toHaveBeenCalled();
  });

  it("未認証は 401", async () => {
    const { handlers, useCases } = setup({ actor: null });
    const response = await handlers.upsert(putRequest({ status: "success" }), params);
    expect(response.status).toBe(401);
    expect(useCases.upsert).not.toHaveBeenCalled();
  });

  it("Origin 不一致・欠落は 403、Origin なしでも same-origin なら許可", async () => {
    const { handlers, useCases } = setup();
    const bad = await handlers.upsert(
      putRequest({ status: "success" }, { origin: "https://evil.example.test" }),
      params,
    );
    expect(bad.status).toBe(403);
    expect((await problem(bad)).code).toBe("invalid_origin");

    const noOrigin = new Request(`${ORIGIN}/x`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "success" }),
    });
    expect((await handlers.upsert(noOrigin, params)).status).toBe(403);

    const sameSite = new Request(`${ORIGIN}/x`, {
      method: "PUT",
      headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ status: "success" }),
    });
    expect((await handlers.upsert(sameSite, params)).status).toBe(200);
    expect(useCases.upsert).toHaveBeenCalledTimes(1);
  });

  it("Content-Type が JSON でなければ 415、16 KiB 超は 413、JSON 不正は 422", async () => {
    const { handlers } = setup();
    expect(
      (
        await handlers.upsert(
          putRequest({ status: "success" }, { "content-type": "text/plain" }),
          params,
        )
      ).status,
    ).toBe(415);
    expect(
      (await handlers.upsert(putRequest({ status: "success", pad: "x".repeat(17 * 1024) }), params))
        .status,
    ).toBe(413);
    expect((await handlers.upsert(putRequest("{not json"), params)).status).toBe(422);
  });

  it("schema 違反は 422 validation_failed", async () => {
    const { handlers } = setup();
    for (const body of [{}, { status: "done" }, { status: "success", quantity: 1.5 }]) {
      const response = await handlers.upsert(putRequest(body), params);
      expect(response.status).toBe(422);
      expect((await problem(response)).code).toBe("validation_failed");
    }
  });

  it("不正な date は 422(fieldErrors.date)、UUID でない habitId は 404", async () => {
    const { handlers, useCases } = setup();
    const badDate = await handlers.upsert(putRequest({ status: "success" }), {
      habitId: HABIT_ID,
      date: "2026-02-30",
    });
    expect(badDate.status).toBe(422);
    expect((await problem(badDate)).fieldErrors).toHaveProperty("date");

    const badId = await handlers.upsert(putRequest({ status: "success" }), {
      habitId: "not-a-uuid",
      date: "2026-01-14",
    });
    expect(badId.status).toBe(404);
    expect((await problem(badId)).code).toBe("habit_not_found");
    expect(useCases.upsert).not.toHaveBeenCalled();
  });

  it.each([
    [new HabitNotFoundError(), 404, "habit_not_found"],
    [new HabitArchivedError("archived"), 409, "habit_archived"],
    [new EntryDateOutOfRangeError(), 422, "entry_date_out_of_range"],
    [new HabitNotScheduledError(), 422, "habit_not_scheduled"],
    [new InvalidHabitEntryError("quantity", "quantity が不正"), 422, "invalid_habit_entry"],
  ])("use case のエラー %# を HTTP %i / %s に変換する", async (error, status, code) => {
    const { handlers, useCases } = setup();
    useCases.upsert.mockRejectedValueOnce(error);
    const response = await handlers.upsert(putRequest({ status: "success" }), params);
    expect(response.status).toBe(status);
    expect((await problem(response)).code).toBe(code);
  });

  it("InvalidHabitEntryError は問題の項目名を fieldErrors に含める", async () => {
    const { handlers, useCases } = setup();
    useCases.upsert.mockRejectedValueOnce(new InvalidHabitEntryError("quantity", "固定文言"));
    const response = await handlers.upsert(putRequest({ status: "success" }), params);
    expect((await problem(response)).fieldErrors).toEqual({ quantity: ["固定文言"] });
  });

  it("未知のエラーは再 throw し、応答に内部情報を含めない", async () => {
    const { handlers, useCases } = setup();
    useCases.upsert.mockRejectedValueOnce(new Error("connection string leaked"));
    await expect(handlers.upsert(putRequest({ status: "success" }), params)).rejects.toThrow();
  });
});

describe("GET /schedule/{date}", () => {
  const request = new Request(`${ORIGIN}/api/v1/schedule/2026-01-12`);

  it("200 で指定日の予定と earliestDate を返す", async () => {
    const { handlers, useCases } = setup();
    const response = await handlers.scheduleOnDate(request, { date: "2026-01-12" });

    expect(response.status).toBe(200);
    expect(useCases.getOnDate).toHaveBeenCalledWith({ actorUserId: "42", date: "2026-01-12" });
    const body = (await response.json()) as { earliestDate: string };
    expect(body.earliestDate).toBe("2026-01-07");
  });

  it("未認証は 401 で use case を呼ばない", async () => {
    const { handlers, useCases } = setup({ actor: null });
    const response = await handlers.scheduleOnDate(request, { date: "2026-01-12" });
    expect(response.status).toBe(401);
    expect(useCases.getOnDate).not.toHaveBeenCalled();
  });

  it("不正な暦日は 422(use case を呼ばない)", async () => {
    const { handlers, useCases } = setup();
    for (const date of ["2026-02-30", "abc", "2026-1-1", "", "../etc"]) {
      const response = await handlers.scheduleOnDate(request, { date });
      expect(response.status).toBe(422);
      expect((await problem(response)).code).toBe("validation_failed");
    }
    expect(useCases.getOnDate).not.toHaveBeenCalled();
  });

  it("範囲外は 422 entry_date_out_of_range", async () => {
    const { handlers, useCases } = setup();
    useCases.getOnDate.mockRejectedValueOnce(new EntryDateOutOfRangeError());
    const response = await handlers.scheduleOnDate(request, { date: "2026-01-01" });
    expect(response.status).toBe(422);
    expect((await problem(response)).code).toBe("entry_date_out_of_range");
  });
});
