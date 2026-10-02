import {
  HabitNotFoundError,
  HabitVersionConflictError,
  InvalidCursorError,
} from "@habit-app/application";
import type { HabitRecord } from "@habit-app/application";
import { habitListResponseSchema, habitResponseSchema } from "@habit-app/contracts";
import {
  HabitArchivedError,
  InvalidScheduleVersionError,
  UnsupportedScheduleChangeError,
  createHabit,
} from "@habit-app/domain";
import { describe, expect, it, vi } from "vitest";

import { createHabitHandlers } from "./habit-handlers";
import type { HabitUseCases } from "./habit-handlers";

const ORIGIN = "https://app.example.test";
const HABIT_ID = "5d1b6d4e-6b1c-4a0e-9e0e-7a0f8d5b8c11";
const NOW = new Date("2026-10-01T00:00:00.000Z");

const record: HabitRecord = {
  habit: createHabit({
    id: HABIT_ID,
    kind: "build",
    name: "水を飲む",
    purpose: "健康維持",
    cue: "起床直後",
    minimumAction: "コップ1杯",
    initialSchedule: { effectiveFrom: "2026-10-01", daysOfWeek: [1, 2], targetCount: 2 },
  }),
  version: 1,
  createdAt: NOW,
  updatedAt: NOW,
};

function setup(options: { actor?: string | null } = {}) {
  const useCases = {
    create: vi.fn<HabitUseCases["create"]>(async () => record),
    list: vi.fn<HabitUseCases["list"]>(async () => ({ items: [record], nextCursor: null })),
    get: vi.fn<HabitUseCases["get"]>(async () => record),
    update: vi.fn<HabitUseCases["update"]>(async () => record),
    archive: vi.fn<HabitUseCases["archive"]>(async () => record),
  };
  const handlers = createHabitHandlers({
    allowedOrigin: ORIGIN,
    resolveActorUserId: async () => (options.actor === undefined ? "42" : options.actor),
    useCases,
  });
  return { handlers, useCases };
}

function jsonRequest(
  method: string,
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json", origin: ORIGIN, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const createBody = {
  kind: "build",
  name: "水を飲む",
  purpose: "健康維持",
  cue: "起床直後",
  minimumAction: "コップ1杯",
  schedule: { effectiveFrom: "2026-10-01", daysOfWeek: [1, 2], targetCount: 2 },
};

async function problem(response: Response) {
  return (await response.json()) as { code: string; fieldErrors?: Record<string, string[]> };
}

describe("POST /api/v1/habits(HAPI-001)", () => {
  it("201、Location、no-store、契約どおりの本文を返し、actorはsessionから渡す", async () => {
    const { handlers, useCases } = setup();
    const response = await handlers.create(
      jsonRequest("POST", `${ORIGIN}/api/v1/habits`, createBody),
    );

    expect(response.status).toBe(201);
    expect(response.headers.get("location")).toBe(`/api/v1/habits/${HABIT_ID}`);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(habitResponseSchema.safeParse(await response.json()).success).toBe(true);
    expect(useCases.create).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: "42" }));
  });

  it("bodyにuserIdを含めても拒否され、use caseを呼ばない(actorはbodyから受け取らない)", async () => {
    const { handlers, useCases } = setup();
    const response = await handlers.create(
      jsonRequest("POST", `${ORIGIN}/api/v1/habits`, { ...createBody, userId: "1" }),
    );
    expect(response.status).toBe(422);
    expect(useCases.create).not.toHaveBeenCalled();
  });

  it("未認証は401(use caseを呼ばない)", async () => {
    const { handlers, useCases } = setup({ actor: null });
    const response = await handlers.create(
      jsonRequest("POST", `${ORIGIN}/api/v1/habits`, createBody),
    );
    expect(response.status).toBe(401);
    expect((await problem(response)).code).toBe("unauthorized");
    expect(useCases.create).not.toHaveBeenCalled();
  });

  it("Originが不一致・欠落(Sec-Fetch-Siteもsame-originでない)は403", async () => {
    const { handlers, useCases } = setup();
    const mismatch = await handlers.create(
      jsonRequest("POST", `${ORIGIN}/api/v1/habits`, createBody, {
        origin: "https://evil.example",
      }),
    );
    expect(mismatch.status).toBe(403);
    expect((await problem(mismatch)).code).toBe("invalid_origin");

    const missing = await handlers.create(
      new Request(`${ORIGIN}/api/v1/habits`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(createBody),
      }),
    );
    expect(missing.status).toBe(403);
    expect(useCases.create).not.toHaveBeenCalled();
  });

  it("OriginがなくてもSec-Fetch-Site: same-originなら許可する", async () => {
    const { handlers } = setup();
    const response = await handlers.create(
      new Request(`${ORIGIN}/api/v1/habits`, {
        method: "POST",
        headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
        body: JSON.stringify(createBody),
      }),
    );
    expect(response.status).toBe(201);
  });

  it("401は415/422より優先される(未認証に入力検証の詳細を返さない)", async () => {
    const { handlers } = setup({ actor: null });
    const response = await handlers.create(
      new Request(`${ORIGIN}/api/v1/habits`, {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "text/plain" },
        body: "x",
      }),
    );
    expect(response.status).toBe(401);
  });

  it("Content-Typeがapplication/jsonでなければ415", async () => {
    const { handlers } = setup();
    const response = await handlers.create(
      new Request(`${ORIGIN}/api/v1/habits`, {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "text/plain" },
        body: JSON.stringify(createBody),
      }),
    );
    expect(response.status).toBe(415);
  });

  it("charset付きのapplication/jsonは許可する", async () => {
    const { handlers } = setup();
    const response = await handlers.create(
      jsonRequest("POST", `${ORIGIN}/api/v1/habits`, createBody, {
        "content-type": "application/json; charset=utf-8",
      }),
    );
    expect(response.status).toBe(201);
  });

  it("body上限(16KiB)超過は413(Content-Lengthが無くても検出する)", async () => {
    const { handlers, useCases } = setup();
    const big = JSON.stringify({ ...createBody, name: "a".repeat(20_000) });
    const response = await handlers.create(jsonRequest("POST", `${ORIGIN}/api/v1/habits`, big));
    expect(response.status).toBe(413);

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(big));
        controller.close();
      },
    });
    const chunked = await handlers.create(
      new Request(`${ORIGIN}/api/v1/habits`, {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/json" },
        body: stream,
        duplex: "half",
      } as RequestInit),
    );
    expect(chunked.status).toBe(413);
    expect(useCases.create).not.toHaveBeenCalled();
  });

  it("JSONとして不正、schema違反は422(fieldErrors付き)", async () => {
    const { handlers } = setup();
    const broken = await handlers.create(
      jsonRequest("POST", `${ORIGIN}/api/v1/habits`, "{not json"),
    );
    expect(broken.status).toBe(422);
    expect((await problem(broken)).code).toBe("invalid_request_body");

    const invalid = await handlers.create(
      jsonRequest("POST", `${ORIGIN}/api/v1/habits`, { ...createBody, name: "a".repeat(101) }),
    );
    expect(invalid.status).toBe(422);
    const body = await problem(invalid);
    expect(body.code).toBe("validation_failed");
    expect(body.fieldErrors).toHaveProperty("name");
  });

  it("Domainの不変条件違反(reduceのtargetCount等)は422で、エラー本文に入力値の自由記述を含めない", async () => {
    const { handlers, useCases } = setup();
    useCases.create.mockRejectedValueOnce(
      new InvalidScheduleVersionError("reduce の targetCount は 1 固定です(MVP): 2"),
    );
    const response = await handlers.create(
      jsonRequest("POST", `${ORIGIN}/api/v1/habits`, {
        ...createBody,
        name: "秘密の習慣名",
        kind: "reduce",
      }),
    );
    expect(response.status).toBe(422);
    const text = JSON.stringify(await problem(response));
    expect(text).toContain("schedule");
    expect(text).not.toContain("秘密の習慣名");
  });

  it("未知のエラーは握りつぶさず再throwする(内部詳細を応答に出さない)", async () => {
    const { handlers, useCases } = setup();
    useCases.create.mockRejectedValueOnce(new Error("connection refused: db.internal"));
    await expect(
      handlers.create(jsonRequest("POST", `${ORIGIN}/api/v1/habits`, createBody)),
    ).rejects.toThrow("connection refused");
  });
});

describe("GET /api/v1/habits(HAPI-002)", () => {
  it("既定値(status=active, limit=20)でuse caseを呼び、契約どおりの一覧を返す", async () => {
    const { handlers, useCases } = setup();
    const response = await handlers.list(new Request(`${ORIGIN}/api/v1/habits`));

    expect(response.status).toBe(200);
    expect(habitListResponseSchema.safeParse(await response.json()).success).toBe(true);
    expect(useCases.list).toHaveBeenCalledWith({
      actorUserId: "42",
      status: "active",
      limit: 20,
      cursor: undefined,
    });
  });

  it("status/limit/cursorをuse caseへ渡す", async () => {
    const { handlers, useCases } = setup();
    await handlers.list(new Request(`${ORIGIN}/api/v1/habits?status=archived&limit=5&cursor=abc`));
    expect(useCases.list).toHaveBeenCalledWith({
      actorUserId: "42",
      status: "archived",
      limit: 5,
      cursor: "abc",
    });
  });

  it("不正なlimit/status/未知のクエリは422", async () => {
    const { handlers, useCases } = setup();
    for (const query of ["limit=0", "limit=101", "status=all", "userId=1"]) {
      const response = await handlers.list(new Request(`${ORIGIN}/api/v1/habits?${query}`));
      expect(response.status).toBe(422);
    }
    expect(useCases.list).not.toHaveBeenCalled();
  });

  it("不正なcursor(InvalidCursorError)は422でfieldErrors.cursorを返す", async () => {
    const { handlers, useCases } = setup();
    useCases.list.mockRejectedValueOnce(new InvalidCursorError());
    const response = await handlers.list(new Request(`${ORIGIN}/api/v1/habits?cursor=zzz`));
    expect(response.status).toBe(422);
    expect((await problem(response)).fieldErrors).toHaveProperty("cursor");
  });

  it("未認証は401", async () => {
    const { handlers } = setup({ actor: null });
    expect((await handlers.list(new Request(`${ORIGIN}/api/v1/habits`))).status).toBe(401);
  });

  it("GETはOrigin検証の対象外(ブラウザのGETはOriginを付けない)", async () => {
    const { handlers } = setup();
    expect((await handlers.list(new Request(`${ORIGIN}/api/v1/habits`))).status).toBe(200);
  });
});

describe("GET /api/v1/habits/{id}(HAPI-003)", () => {
  const url = `${ORIGIN}/api/v1/habits/${HABIT_ID}`;

  it("200で習慣を返す", async () => {
    const { handlers, useCases } = setup();
    const response = await handlers.get(new Request(url), { habitId: HABIT_ID });
    expect(response.status).toBe(200);
    expect(useCases.get).toHaveBeenCalledWith({ actorUserId: "42", habitId: HABIT_ID });
  });

  it("所有者でない/存在しない(NotFound)と、UUIDでないidは同一の404", async () => {
    const { handlers, useCases } = setup();
    useCases.get.mockRejectedValueOnce(new HabitNotFoundError());
    const notOwned = await handlers.get(new Request(url), { habitId: HABIT_ID });
    const malformed = await handlers.get(new Request(url), { habitId: "12345" });

    expect(notOwned.status).toBe(404);
    expect(malformed.status).toBe(404);
    expect((await problem(notOwned)).code).toBe("habit_not_found");
    expect((await problem(malformed)).code).toBe("habit_not_found");
    expect(useCases.get).toHaveBeenCalledTimes(1);
  });

  it("未認証は、存在有無にかかわらず401", async () => {
    const { handlers } = setup({ actor: null });
    expect((await handlers.get(new Request(url), { habitId: "12345" })).status).toBe(401);
  });
});

describe("PATCH /api/v1/habits/{id}(HAPI-004)", () => {
  const url = `${ORIGIN}/api/v1/habits/${HABIT_ID}`;

  it("versionと変更項目をuse caseへ渡す(replacementAction=nullも渡す)", async () => {
    const { handlers, useCases } = setup();
    const response = await handlers.update(
      jsonRequest("PATCH", url, { version: 3, name: "新名称", replacementAction: null }),
      { habitId: HABIT_ID },
    );
    expect(response.status).toBe(200);
    expect(useCases.update).toHaveBeenCalledWith({
      actorUserId: "42",
      habitId: HABIT_ID,
      version: 3,
      details: { name: "新名称", replacementAction: null },
      schedule: undefined,
    });
  });

  it("scheduleのみの更新ではdetailsを渡さない", async () => {
    const { handlers, useCases } = setup();
    await handlers.update(
      jsonRequest("PATCH", url, {
        version: 1,
        schedule: { effectiveFrom: "2026-11-01", daysOfWeek: [3] },
      }),
      { habitId: HABIT_ID },
    );
    expect(useCases.update).toHaveBeenCalledWith(
      expect.objectContaining({
        details: undefined,
        schedule: { effectiveFrom: "2026-11-01", daysOfWeek: [3], targetCount: 1 },
      }),
    );
  });

  it("version競合は409 version_conflict、アーカイブ済みは409 habit_archived", async () => {
    const { handlers, useCases } = setup();
    useCases.update.mockRejectedValueOnce(new HabitVersionConflictError());
    const conflict = await handlers.update(jsonRequest("PATCH", url, { version: 1, name: "x" }), {
      habitId: HABIT_ID,
    });
    expect(conflict.status).toBe(409);
    expect((await problem(conflict)).code).toBe("version_conflict");

    useCases.update.mockRejectedValueOnce(new HabitArchivedError("archived"));
    const archived = await handlers.update(jsonRequest("PATCH", url, { version: 1, name: "x" }), {
      habitId: HABIT_ID,
    });
    expect(archived.status).toBe(409);
    expect((await problem(archived)).code).toBe("habit_archived");
  });

  it("遡及的なスケジュール変更は422", async () => {
    const { handlers, useCases } = setup();
    useCases.update.mockRejectedValueOnce(new UnsupportedScheduleChangeError("retroactive"));
    const response = await handlers.update(
      jsonRequest("PATCH", url, {
        version: 1,
        schedule: { effectiveFrom: "2020-01-01", daysOfWeek: [1] },
      }),
      { habitId: HABIT_ID },
    );
    expect(response.status).toBe(422);
  });

  it("kindの変更・変更項目なし・version欠落は422でuse caseを呼ばない", async () => {
    const { handlers, useCases } = setup();
    for (const body of [{ version: 1, kind: "reduce" }, { version: 1 }, { name: "x" }]) {
      const response = await handlers.update(jsonRequest("PATCH", url, body), {
        habitId: HABIT_ID,
      });
      expect(response.status).toBe(422);
    }
    expect(useCases.update).not.toHaveBeenCalled();
  });

  it("Origin不一致は403、未認証は401、UUIDでないidは404", async () => {
    const { handlers } = setup();
    expect(
      (
        await handlers.update(
          jsonRequest("PATCH", url, { version: 1, name: "x" }, { origin: "https://evil.example" }),
          { habitId: HABIT_ID },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await handlers.update(jsonRequest("PATCH", url, { version: 1, name: "x" }), {
          habitId: "nope",
        })
      ).status,
    ).toBe(404);
    const unauthenticated = setup({ actor: null });
    expect(
      (
        await unauthenticated.handlers.update(
          jsonRequest("PATCH", url, { version: 1, name: "x" }),
          {
            habitId: HABIT_ID,
          },
        )
      ).status,
    ).toBe(401);
  });
});

describe("POST /api/v1/habits/{id}/archive(HAPI-005)", () => {
  const url = `${ORIGIN}/api/v1/habits/${HABIT_ID}/archive`;

  it("200でアーカイブし、versionをuse caseへ渡す", async () => {
    const { handlers, useCases } = setup();
    const response = await handlers.archive(jsonRequest("POST", url, { version: 2 }), {
      habitId: HABIT_ID,
    });
    expect(response.status).toBe(200);
    expect(useCases.archive).toHaveBeenCalledWith({
      actorUserId: "42",
      habitId: HABIT_ID,
      version: 2,
    });
  });

  it("他ユーザーの習慣(NotFound)は404、version競合は409", async () => {
    const { handlers, useCases } = setup();
    useCases.archive.mockRejectedValueOnce(new HabitNotFoundError());
    expect(
      (await handlers.archive(jsonRequest("POST", url, { version: 1 }), { habitId: HABIT_ID }))
        .status,
    ).toBe(404);
    useCases.archive.mockRejectedValueOnce(new HabitVersionConflictError());
    expect(
      (await handlers.archive(jsonRequest("POST", url, { version: 1 }), { habitId: HABIT_ID }))
        .status,
    ).toBe(409);
  });

  it("versionなし・未知キーは422、Origin不一致は403、未認証は401", async () => {
    const { handlers } = setup();
    expect(
      (await handlers.archive(jsonRequest("POST", url, {}), { habitId: HABIT_ID })).status,
    ).toBe(422);
    expect(
      (
        await handlers.archive(jsonRequest("POST", url, { version: 1, name: "x" }), {
          habitId: HABIT_ID,
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await handlers.archive(
          jsonRequest("POST", url, { version: 1 }, { origin: "https://evil.example" }),
          { habitId: HABIT_ID },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await setup({ actor: null }).handlers.archive(jsonRequest("POST", url, { version: 1 }), {
          habitId: HABIT_ID,
        })
      ).status,
    ).toBe(401);
  });
});
