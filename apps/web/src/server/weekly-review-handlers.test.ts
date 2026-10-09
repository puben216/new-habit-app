import {
  InvalidWeeklyReviewCursorError,
  ReviewWeekNotAllowedError,
  UserNotFoundError,
  WeeklyReviewAlreadyCompletedError,
  WeeklyReviewNotFoundError,
} from "@habit-app/application";
import type { WeeklyReview } from "@habit-app/application";
import { weeklyReviewListResponseSchema, weeklyReviewResponseSchema } from "@habit-app/contracts";
import { InvalidWeeklyReviewError } from "@habit-app/domain";
import { describe, expect, it, vi } from "vitest";

import { createWeeklyReviewHandlers } from "./weekly-review-handlers";
import type { WeeklyReviewUseCases } from "./weekly-review-handlers";

const ORIGIN = "https://app.example.test";
const NOW = new Date("2026-01-14T03:00:00.000Z");
const REVIEW_ID = "10000000-0000-4000-8000-000000000001";
const HABIT_ID = "00000000-0000-4000-8000-000000000001";

const outcomes = {
  scheduled: 7,
  success: 4,
  missed: 2,
  skipped: 1,
  pending: 0,
  successRate: 4 / 6,
};

const review: WeeklyReview = {
  id: REVIEW_ID,
  weekStart: "2026-01-05",
  weekEnd: "2026-01-11",
  timezone: "Asia/Tokyo",
  status: "draft",
  summary: {
    schemaVersion: 1,
    weekStart: "2026-01-05",
    weekEnd: "2026-01-11",
    overall: outcomes,
    habits: [{ ...outcomes, habitId: HABIT_ID, kind: "build", name: "水を飲む" }],
    checkIn: { days: 2, averageMood: 3, averageDifficulty: null },
  },
  reflection: null,
  completedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
};

function setup(options: { actor?: string | null } = {}) {
  const useCases = {
    create: vi.fn<WeeklyReviewUseCases["create"]>(async () => ({ review, created: true })),
    get: vi.fn<WeeklyReviewUseCases["get"]>(async () => review),
    list: vi.fn<WeeklyReviewUseCases["list"]>(async () => ({ items: [review], nextCursor: null })),
    update: vi.fn<WeeklyReviewUseCases["update"]>(async () => review),
  };
  const handlers = createWeeklyReviewHandlers({
    allowedOrigin: ORIGIN,
    resolveActorUserId: async () => (options.actor === undefined ? "42" : options.actor),
    useCases,
  });
  return { handlers, useCases };
}

const params = { reviewId: REVIEW_ID };
const base = `${ORIGIN}/api/v1/weekly-reviews`;

function jsonRequest(
  method: "POST" | "PATCH",
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

async function problem(response: Response) {
  return (await response.json()) as {
    code: string;
    message: string;
    fieldErrors?: Record<string, string[]>;
  };
}

describe("POST /weekly-reviews", () => {
  it("新規作成は 201 と Location、内部 ID を含まない応答、no-store", async () => {
    const { handlers, useCases } = setup();
    const response = await handlers.create(jsonRequest("POST", base, { weekStart: "2026-01-05" }));
    expect(response.status).toBe(201);
    expect(response.headers.get("location")).toBe(`/api/v1/weekly-reviews/${REVIEW_ID}`);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = weeklyReviewResponseSchema.parse(await response.json());
    expect(body).toMatchObject({ id: REVIEW_ID, status: "draft", weekEnd: "2026-01-11" });
    expect(Object.keys(body).sort()).toEqual(
      [
        "completedAt",
        "createdAt",
        "id",
        "reflection",
        "status",
        "summary",
        "timezone",
        "updatedAt",
        "weekEnd",
        "weekStart",
      ].sort(),
    );
    expect(useCases.create).toHaveBeenCalledWith({ actorUserId: "42", weekStart: "2026-01-05" });
  });

  it("既存のレビューは 200(Location なし)", async () => {
    const { handlers, useCases } = setup();
    useCases.create.mockResolvedValueOnce({ review, created: false });
    const response = await handlers.create(jsonRequest("POST", base, { weekStart: "2026-01-05" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
  });

  it("未認証は 401 で use case を呼ばない", async () => {
    const { handlers, useCases } = setup({ actor: null });
    const response = await handlers.create(jsonRequest("POST", base, { weekStart: "2026-01-05" }));
    expect(response.status).toBe(401);
    expect(useCases.create).not.toHaveBeenCalled();
  });

  it("Origin が不正なら 403(認証・検証より先に拒否)", async () => {
    const { handlers, useCases } = setup();
    const response = await handlers.create(
      jsonRequest("POST", base, { weekStart: "2026-01-05" }, { origin: "https://evil.example" }),
    );
    expect(response.status).toBe(403);
    expect(useCases.create).not.toHaveBeenCalled();
  });

  it("Content-Type が JSON でなければ 415、不正な JSON・schema 違反は 422", async () => {
    const { handlers, useCases } = setup();
    const plain = await handlers.create(
      jsonRequest("POST", base, "weekStart=2026-01-05", { "content-type": "text/plain" }),
    );
    expect(plain.status).toBe(415);

    const broken = await handlers.create(jsonRequest("POST", base, "{"));
    expect(broken.status).toBe(422);

    for (const body of [
      {},
      { weekStart: "2026-02-30" },
      { weekStart: "2026-01-05", userId: "1" },
    ]) {
      const response = await handlers.create(jsonRequest("POST", base, body));
      expect(response.status).toBe(422);
      expect((await problem(response)).code).toBe("validation_failed");
    }
    expect(useCases.create).not.toHaveBeenCalled();
  });

  it("body が大きすぎれば 413", async () => {
    const { handlers } = setup();
    const response = await handlers.create(
      jsonRequest(
        "POST",
        base,
        JSON.stringify({ weekStart: "2026-01-05", pad: "x".repeat(20_000) }),
      ),
    );
    expect(response.status).toBe(413);
  });

  it.each([
    ["not_week_start", "週の開始日"],
    ["not_ended", "終了した週"],
    ["too_old", "52 週"],
  ] as const)(
    "対象週の違反 %s は 422 week_not_reviewable で理由を区別する",
    async (reason, text) => {
      const { handlers, useCases } = setup();
      useCases.create.mockRejectedValueOnce(new ReviewWeekNotAllowedError(reason));
      const response = await handlers.create(
        jsonRequest("POST", base, { weekStart: "2026-01-06" }),
      );
      expect(response.status).toBe(422);
      const body = await problem(response);
      expect(body.code).toBe("week_not_reviewable");
      expect(body.fieldErrors?.["weekStart"]?.[0]).toContain(text);
    },
  );

  it("user 不存在は 404 user_not_found", async () => {
    const { handlers, useCases } = setup();
    useCases.create.mockRejectedValueOnce(new UserNotFoundError());
    const response = await handlers.create(jsonRequest("POST", base, { weekStart: "2026-01-05" }));
    expect(response.status).toBe(404);
    expect((await problem(response)).code).toBe("user_not_found");
  });

  it("未知のエラーは握りつぶさず再 throw する(内部詳細を応答へ出さない)", async () => {
    const { handlers, useCases } = setup();
    useCases.create.mockRejectedValueOnce(new Error("secret internal detail"));
    await expect(
      handlers.create(jsonRequest("POST", base, { weekStart: "2026-01-05" })),
    ).rejects.toThrow("secret internal detail");
  });
});

describe("GET /weekly-reviews", () => {
  it("200 で items と nextCursor を返し、既定の limit は 20", async () => {
    const { handlers, useCases } = setup();
    useCases.list.mockResolvedValueOnce({ items: [review], nextCursor: "abc" });
    const response = await handlers.list(new Request(base));
    expect(response.status).toBe(200);
    expect(weeklyReviewListResponseSchema.parse(await response.json())).toMatchObject({
      nextCursor: "abc",
    });
    expect(useCases.list).toHaveBeenCalledWith({
      actorUserId: "42",
      limit: 20,
      cursor: undefined,
    });
  });

  it("limit と cursor を use case へ渡す", async () => {
    const { handlers, useCases } = setup();
    await handlers.list(new Request(`${base}?limit=5&cursor=xyz`));
    expect(useCases.list).toHaveBeenCalledWith({ actorUserId: "42", limit: 5, cursor: "xyz" });
  });

  it.each(["limit=0", "limit=51", "limit=abc", "cursor=", "foo=bar"])(
    "不正な query %s は 422",
    async (query) => {
      const { handlers, useCases } = setup();
      const response = await handlers.list(new Request(`${base}?${query}`));
      expect(response.status).toBe(422);
      expect(useCases.list).not.toHaveBeenCalled();
    },
  );

  it("不正な cursor は 422 invalid_cursor", async () => {
    const { handlers, useCases } = setup();
    useCases.list.mockRejectedValueOnce(new InvalidWeeklyReviewCursorError());
    const response = await handlers.list(new Request(`${base}?cursor=zzz`));
    expect(response.status).toBe(422);
    expect((await problem(response)).code).toBe("invalid_cursor");
  });

  it("未認証は 401", async () => {
    const { handlers } = setup({ actor: null });
    expect((await handlers.list(new Request(base))).status).toBe(401);
  });
});

describe("GET /weekly-reviews/{reviewId}", () => {
  it("200 で自分のレビューを返す", async () => {
    const { handlers, useCases } = setup();
    const response = await handlers.get(new Request(`${base}/${REVIEW_ID}`), params);
    expect(response.status).toBe(200);
    expect(useCases.get).toHaveBeenCalledWith({ actorUserId: "42", reviewId: REVIEW_ID });
  });

  it("UUID 形式でない ID は use case を呼ばず 404(存在を区別しない)", async () => {
    const { handlers, useCases } = setup();
    for (const reviewId of ["1", "abc", "../x", "' OR 1=1 --"]) {
      const response = await handlers.get(new Request(`${base}/${reviewId}`), { reviewId });
      expect(response.status).toBe(404);
      expect((await problem(response)).code).toBe("weekly_review_not_found");
    }
    expect(useCases.get).not.toHaveBeenCalled();
  });

  it("他人・存在しないレビューは 404 weekly_review_not_found", async () => {
    const { handlers, useCases } = setup();
    useCases.get.mockRejectedValueOnce(new WeeklyReviewNotFoundError());
    const response = await handlers.get(new Request(`${base}/${REVIEW_ID}`), params);
    expect(response.status).toBe(404);
    expect((await problem(response)).code).toBe("weekly_review_not_found");
  });

  it("未認証は 401", async () => {
    const { handlers } = setup({ actor: null });
    expect((await handlers.get(new Request(`${base}/${REVIEW_ID}`), params)).status).toBe(401);
  });
});

describe("PATCH /weekly-reviews/{reviewId}", () => {
  const url = `${base}/${REVIEW_ID}`;

  it("reflection のみの更新は complete=false で use case へ渡す", async () => {
    const { handlers, useCases } = setup();
    const response = await handlers.update(
      jsonRequest("PATCH", url, { reflection: "よく続いた" }),
      params,
    );
    expect(response.status).toBe(200);
    expect(useCases.update).toHaveBeenCalledWith({
      actorUserId: "42",
      reviewId: REVIEW_ID,
      reflection: "よく続いた",
      complete: false,
    });
  });

  it("status: completed は complete=true、reflection を省略すると undefined(変更しない)", async () => {
    const { handlers, useCases } = setup();
    await handlers.update(jsonRequest("PATCH", url, { status: "completed" }), params);
    expect(useCases.update).toHaveBeenCalledWith({
      actorUserId: "42",
      reviewId: REVIEW_ID,
      reflection: undefined,
      complete: true,
    });
  });

  it("reflection: null はクリアとして null のまま渡す", async () => {
    const { handlers, useCases } = setup();
    await handlers.update(jsonRequest("PATCH", url, { reflection: null }), params);
    expect(useCases.update).toHaveBeenCalledWith(
      expect.objectContaining({ reflection: null, complete: false }),
    );
  });

  it("確定済みは 409 weekly_review_already_completed", async () => {
    const { handlers, useCases } = setup();
    useCases.update.mockRejectedValueOnce(new WeeklyReviewAlreadyCompletedError());
    const response = await handlers.update(
      jsonRequest("PATCH", url, { reflection: "追記" }),
      params,
    );
    expect(response.status).toBe(409);
    expect((await problem(response)).code).toBe("weekly_review_already_completed");
  });

  it("他人・存在しないレビューは 404", async () => {
    const { handlers, useCases } = setup();
    useCases.update.mockRejectedValueOnce(new WeeklyReviewNotFoundError());
    const response = await handlers.update(
      jsonRequest("PATCH", url, { status: "completed" }),
      params,
    );
    expect(response.status).toBe(404);
  });

  it("UUID 形式でない ID は 404 で use case を呼ばない", async () => {
    const { handlers, useCases } = setup();
    const response = await handlers.update(jsonRequest("PATCH", url, { status: "completed" }), {
      reviewId: "nope",
    });
    expect(response.status).toBe(404);
    expect(useCases.update).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { status: "draft" },
    { status: "completed", weekStart: "2026-01-05" },
    { reflection: 1 },
    { reflection: "x".repeat(1001) },
    { reflection: "a\u0000b" },
  ])("不正な body %j は 422 で use case を呼ばない", async (body) => {
    const { handlers, useCases } = setup();
    const response = await handlers.update(jsonRequest("PATCH", url, body), params);
    expect(response.status).toBe(422);
    expect(useCases.update).not.toHaveBeenCalled();
  });

  it("Domain の検証エラーは 422 で項目名を返し、入力の自由記述を含めない", async () => {
    const { handlers, useCases } = setup();
    useCases.update.mockRejectedValueOnce(
      new InvalidWeeklyReviewError(
        "reflection",
        "reflection は 1000 文字以内である必要があります。",
      ),
    );
    const response = await handlers.update(
      jsonRequest("PATCH", url, { reflection: "秘密のメモ" }),
      params,
    );
    expect(response.status).toBe(422);
    const text = JSON.stringify(await problem(response));
    expect(text).toContain("reflection");
    expect(text).not.toContain("秘密のメモ");
  });

  it("Origin 不正は 403、未認証は 401、Content-Type 不正は 415", async () => {
    const { handlers, useCases } = setup();
    expect(
      (
        await handlers.update(
          jsonRequest("PATCH", url, { status: "completed" }, { origin: "https://evil.example" }),
          params,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await handlers.update(
          jsonRequest("PATCH", url, "x", { "content-type": "text/plain" }),
          params,
        )
      ).status,
    ).toBe(415);
    const anon = setup({ actor: null });
    expect(
      (await anon.handlers.update(jsonRequest("PATCH", url, { status: "completed" }), params))
        .status,
    ).toBe(401);
    expect(useCases.update).not.toHaveBeenCalled();
  });
});
