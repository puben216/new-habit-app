import { InvalidWeeklyReviewError } from "@habit-app/domain";
import type { HabitEntryStatus, WeekStartsOn } from "@habit-app/domain";
import { describe, expect, it } from "vitest";

import { createFakeHabitRepository, createSequentialIdGenerator } from "../habits/test-fakes";
import { createHabitUseCase } from "../habits/use-cases";
import { createFakeProfileRepository } from "../identity/test-fakes";
import { createFakeDailyCheckInRepository } from "./check-in-test-fakes";
import {
  CorruptedWeeklyReviewError,
  InvalidWeeklyReviewCursorError,
  ReviewWeekNotAllowedError,
  UserNotFoundError,
  WeeklyReviewAlreadyCompletedError,
  WeeklyReviewNotFoundError,
} from "./errors";
import { createFakeHabitEntryRepository } from "./test-fakes";
import { decodeWeeklyReviewCursor, encodeWeeklyReviewCursor } from "./weekly-review-cursor";
import { createFakeWeeklyReviewRepository } from "./weekly-review-test-fakes";
import {
  createWeeklyReviewUseCase,
  getWeeklyReviewUseCase,
  listWeeklyReviewsUseCase,
  updateWeeklyReviewUseCase,
} from "./weekly-review-use-cases";

const USER_A = "1";
const USER_B = "2";
const USER_MISSING = "99";

// 2026-01-14(水)12:00 JST。週(月曜始まり)は 2026-01-05(月)〜2026-01-11(日)。
const WED_NOON_JST = "2026-01-14T03:00:00Z";
const WEEK = "2026-01-05";

function setup(
  nowIso = WED_NOON_JST,
  options: { timezone?: string; weekStartsOn?: WeekStartsOn } = {},
) {
  let nowValue = new Date(nowIso);
  let nowCalls = 0;
  const clock = () => {
    nowCalls += 1;
    return nowValue;
  };
  const habitRepository = createFakeHabitRepository();
  const idGenerator = createSequentialIdGenerator();
  const profileRepository = createFakeProfileRepository([USER_A, USER_B]);
  for (const userId of [USER_A, USER_B]) {
    profileRepository.seed({
      userId,
      displayName: null,
      timezone: options.timezone ?? "Asia/Tokyo",
      locale: "ja",
      weekStartsOn: options.weekStartsOn ?? 1,
      updatedAt: nowValue,
    });
  }
  const entryRepository = createFakeHabitEntryRepository([]);
  const checkInRepository = createFakeDailyCheckInRepository([USER_A, USER_B]);
  const reviewRepository = createFakeWeeklyReviewRepository([USER_A, USER_B]);

  async function createHabit(
    actorUserId: string,
    name: string,
    daysOfWeek = [0, 1, 2, 3, 4, 5, 6],
  ) {
    const record = await createHabitUseCase(
      { habitRepository, idGenerator, now: () => nowValue },
      {
        actorUserId,
        kind: "build",
        name,
        purpose: "健康維持",
        cue: "起床直後",
        minimumAction: "コップ1杯",
        schedule: { effectiveFrom: "2025-01-01", daysOfWeek, targetCount: 1 },
      },
    );
    return record.habit.id;
  }

  function record(actorUserId: string, habitId: string, date: string, status: HabitEntryStatus) {
    entryRepository.seed(actorUserId, {
      habitId,
      date,
      status,
      quantity: status === "skipped" ? null : status === "success" ? 1 : 0,
      createdAt: nowValue,
      updatedAt: nowValue,
    });
  }

  function checkIn(
    actorUserId: string,
    date: string,
    mood: number | null,
    difficulty: number | null,
  ) {
    checkInRepository.seed(actorUserId, {
      date,
      mood,
      difficulty,
      note: "メモ",
      createdAt: nowValue,
      updatedAt: nowValue,
    });
  }

  const createDeps = () => ({
    reviewRepository,
    habitRepository,
    entryRepository,
    checkInRepository,
    profileRepository,
    now: clock,
  });

  return {
    reviewRepository,
    entryRepository,
    checkInRepository,
    habitRepository,
    createHabit,
    record,
    checkIn,
    createDeps,
    setNow(iso: string) {
      nowValue = new Date(iso);
    },
    nowCalls: () => nowCalls,
  };
}

describe("createWeeklyReviewUseCase", () => {
  it("終了した週のレビューを draft で作成し、集計スナップショットを保存する", async () => {
    const s = setup();
    const habitId = await s.createHabit(USER_A, "水を飲む");
    for (const [day, status] of [
      ["2026-01-05", "success"],
      ["2026-01-06", "success"],
      ["2026-01-07", "success"],
      ["2026-01-08", "success"],
      ["2026-01-09", "skipped"],
    ] as const) {
      s.record(USER_A, habitId, day, status);
    }
    s.checkIn(USER_A, "2026-01-06", 4, 3);
    s.checkIn(USER_A, "2026-01-08", 2, null);

    const { review, created } = await createWeeklyReviewUseCase(s.createDeps(), {
      actorUserId: USER_A,
      weekStart: WEEK,
    });

    expect(created).toBe(true);
    expect(review).toMatchObject({
      weekStart: "2026-01-05",
      weekEnd: "2026-01-11",
      timezone: "Asia/Tokyo",
      status: "draft",
      reflection: null,
      completedAt: null,
    });
    expect(review.summary.overall).toEqual({
      scheduled: 7,
      success: 4,
      missed: 2,
      skipped: 1,
      pending: 0,
      successRate: 4 / 6,
    });
    expect(review.summary.habits).toEqual([
      expect.objectContaining({ habitId, kind: "build", name: "水を飲む", scheduled: 7 }),
    ]);
    expect(review.summary.checkIn).toEqual({ days: 2, averageMood: 3, averageDifficulty: 3 });
    // 習慣の purpose/cue・チェックインのメモはスナップショットに含まれない
    expect(JSON.stringify(review.summary)).not.toContain("健康維持");
    expect(JSON.stringify(review.summary)).not.toContain("メモ");
  });

  it("同じ週の再作成は既存を返し、再計算しない(スナップショットは作成時のまま)", async () => {
    const s = setup();
    const habitId = await s.createHabit(USER_A, "水を飲む");
    const first = await createWeeklyReviewUseCase(s.createDeps(), {
      actorUserId: USER_A,
      weekStart: WEEK,
    });
    expect(first.review.summary.overall.success).toBe(0);

    s.record(USER_A, habitId, "2026-01-05", "success");
    const second = await createWeeklyReviewUseCase(s.createDeps(), {
      actorUserId: USER_A,
      weekStart: WEEK,
    });
    expect(second.created).toBe(false);
    expect(second.review.id).toBe(first.review.id);
    expect(second.review.summary.overall.success).toBe(0);
    expect(s.reviewRepository.reviews.size).toBe(1);
  });

  it("既存があれば習慣・記録・チェックインを取得しない(再計算のための読み取りもしない)", async () => {
    const s = setup();
    await s.createHabit(USER_A, "水を飲む");
    await createWeeklyReviewUseCase(s.createDeps(), { actorUserId: USER_A, weekStart: WEEK });
    const entryCalls = s.entryRepository.calls.length;
    const checkInCalls = s.checkInRepository.calls.length;
    const habitListCalls = s.habitRepository.calls.length;

    await createWeeklyReviewUseCase(s.createDeps(), { actorUserId: USER_A, weekStart: WEEK });

    expect(s.entryRepository.calls.length).toBe(entryCalls);
    expect(s.checkInRepository.calls.length).toBe(checkInCalls);
    expect(s.habitRepository.calls.length).toBe(habitListCalls);
  });

  it("並行作成の敗者(検索では未作成だったが保存時に既存があった)は created=false で既存を返す", async () => {
    const s = setup();
    const winner = await createWeeklyReviewUseCase(s.createDeps(), {
      actorUserId: USER_A,
      weekStart: WEEK,
    });
    // 検索の時点ではまだ存在しなかったことを再現する(別リクエストが直後に作成した状況)。
    const racing = {
      ...s.createDeps(),
      reviewRepository: {
        ...s.reviewRepository,
        findByWeekStart: async () => null,
        createIfAbsent: s.reviewRepository.createIfAbsent,
      },
    };
    const loser = await createWeeklyReviewUseCase(racing, { actorUserId: USER_A, weekStart: WEEK });
    expect(loser.created).toBe(false);
    expect(loser.review.id).toBe(winner.review.id);
    expect(s.reviewRepository.reviews.size).toBe(1);
  });

  it("確定済みのレビューも同じ週の再作成では既存をそのまま返す", async () => {
    const s = setup();
    const first = await createWeeklyReviewUseCase(s.createDeps(), {
      actorUserId: USER_A,
      weekStart: WEEK,
    });
    await updateWeeklyReviewUseCase(
      { reviewRepository: s.reviewRepository, now: () => new Date(WED_NOON_JST) },
      { actorUserId: USER_A, reviewId: first.review.id, complete: true },
    );
    const again = await createWeeklyReviewUseCase(s.createDeps(), {
      actorUserId: USER_A,
      weekStart: WEEK,
    });
    expect(again.created).toBe(false);
    expect(again.review.status).toBe("completed");
  });

  it("習慣も記録もない週でも作成できる(件数 0、成功率 null、チェックインなし)", async () => {
    const s = setup();
    const { review } = await createWeeklyReviewUseCase(s.createDeps(), {
      actorUserId: USER_A,
      weekStart: WEEK,
    });
    expect(review.summary.overall).toMatchObject({ scheduled: 0, successRate: null });
    expect(review.summary.habits).toEqual([]);
    expect(review.summary.checkIn).toEqual({ days: 0, averageMood: null, averageDifficulty: null });
  });

  it("他ユーザーの習慣・記録・チェックイン、アーカイブ済み習慣、週外の記録は混ざらない", async () => {
    const s = setup();
    const mine = await s.createHabit(USER_A, "自分の習慣");
    const others = await s.createHabit(USER_B, "他人の習慣");
    s.record(USER_A, mine, "2026-01-05", "success");
    s.record(USER_B, others, "2026-01-05", "success");
    s.record(USER_A, mine, "2026-01-12", "success"); // 翌週
    s.checkIn(USER_B, "2026-01-06", 5, 5);

    const { review } = await createWeeklyReviewUseCase(s.createDeps(), {
      actorUserId: USER_A,
      weekStart: WEEK,
    });
    expect(review.summary.habits.map((habit) => habit.name)).toEqual(["自分の習慣"]);
    expect(review.summary.overall.success).toBe(1);
    expect(review.summary.checkIn.days).toBe(0);
    expect(s.reviewRepository.calls.every((call) => call.actorUserId === USER_A)).toBe(true);
    expect(s.entryRepository.calls.every((call) => call.actorUserId === USER_A)).toBe(true);
    expect(s.checkInRepository.calls.every((call) => call.actorUserId === USER_A)).toBe(true);
  });

  it("記録・チェックインの取得は習慣数に依らず 1 回ずつ", async () => {
    const s = setup();
    await s.createHabit(USER_A, "A");
    await s.createHabit(USER_A, "B");
    await s.createHabit(USER_A, "C");
    await createWeeklyReviewUseCase(s.createDeps(), { actorUserId: USER_A, weekStart: WEEK });
    expect(s.entryRepository.calls.filter((c) => c.actorUserId === USER_A)).toHaveLength(1);
    expect(s.checkInRepository.calls.filter((c) => c.method === "listByDateRange")).toHaveLength(1);
  });

  it("Clock は 1 回だけ参照する(日付境界での不整合を避ける)", async () => {
    const s = setup();
    await createWeeklyReviewUseCase(s.createDeps(), { actorUserId: USER_A, weekStart: WEEK });
    expect(s.nowCalls()).toBe(1);
  });

  it.each([
    ["2026-01-06", "not_week_start"], // 火曜
    ["2026-01-04", "not_week_start"], // 日曜
    ["2026-02-30", "not_week_start"], // 実在しない
    ["2026-01-12", "not_ended"], // 今週
    ["2026-01-19", "not_ended"], // 来週
    ["2025-01-06", "too_old"], // 53 週前
  ])("weekStart=%s は %s で拒否し、何も保存しない", async (weekStart, reason) => {
    const s = setup();
    const error = await createWeeklyReviewUseCase(s.createDeps(), {
      actorUserId: USER_A,
      weekStart,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ReviewWeekNotAllowedError);
    expect((error as ReviewWeekNotAllowedError).reason).toBe(reason);
    expect(s.reviewRepository.reviews.size).toBe(0);
  });

  it("52 週前の開始日は作成できる", async () => {
    const s = setup();
    const { created } = await createWeeklyReviewUseCase(s.createDeps(), {
      actorUserId: USER_A,
      weekStart: "2025-01-13",
    });
    expect(created).toBe(true);
  });

  it("週の最終日の翌日(ローカル日)から作成できる: Asia/Tokyo の日付繰り上がり", async () => {
    const before = setup("2026-01-11T14:59:59Z"); // Tokyo では 2026-01-11 23:59:59
    await expect(
      createWeeklyReviewUseCase(before.createDeps(), { actorUserId: USER_A, weekStart: WEEK }),
    ).rejects.toBeInstanceOf(ReviewWeekNotAllowedError);

    const after = setup("2026-01-11T15:00:00Z"); // Tokyo では 2026-01-12
    const { created } = await createWeeklyReviewUseCase(after.createDeps(), {
      actorUserId: USER_A,
      weekStart: WEEK,
    });
    expect(created).toBe(true);
  });

  it("weekStartsOn が日曜(0)なら日曜が週の開始日で、月曜は拒否される", async () => {
    const s = setup(WED_NOON_JST, { weekStartsOn: 0 });
    await expect(
      createWeeklyReviewUseCase(s.createDeps(), { actorUserId: USER_A, weekStart: WEEK }),
    ).rejects.toMatchObject({ reason: "not_week_start" });
    const { review } = await createWeeklyReviewUseCase(s.createDeps(), {
      actorUserId: USER_A,
      weekStart: "2026-01-04",
    });
    expect(review.weekEnd).toBe("2026-01-10");
  });

  it("user が存在しなければ UserNotFoundError", async () => {
    const s = setup();
    await expect(
      createWeeklyReviewUseCase(s.createDeps(), { actorUserId: USER_MISSING, weekStart: WEEK }),
    ).rejects.toBeInstanceOf(UserNotFoundError);
    expect(s.reviewRepository.reviews.size).toBe(0);
  });

  it("保存済みスナップショットが schema に合わない場合はデータ破損として内部エラー", async () => {
    const s = setup();
    s.reviewRepository.seed(USER_A, {
      id: "10000000-0000-4000-8000-0000000000aa",
      weekStart: WEEK,
      timezone: "Asia/Tokyo",
      summary: { schemaVersion: 2 },
      reflection: null,
      status: "draft",
      completedAt: null,
      createdAt: new Date(WED_NOON_JST),
      updatedAt: new Date(WED_NOON_JST),
    });
    await expect(
      createWeeklyReviewUseCase(s.createDeps(), { actorUserId: USER_A, weekStart: WEEK }),
    ).rejects.toBeInstanceOf(CorruptedWeeklyReviewError);
  });
});

async function seedReviews(s: ReturnType<typeof setup>, weeks: readonly string[], actor = USER_A) {
  const ids: string[] = [];
  for (const weekStart of weeks) {
    // 作成可能な範囲(52 週以内・終了済み)の週のみ使う
    const { review } = await createWeeklyReviewUseCase(s.createDeps(), {
      actorUserId: actor,
      weekStart,
    });
    ids.push(review.id);
  }
  return ids;
}

describe("getWeeklyReviewUseCase / listWeeklyReviewsUseCase", () => {
  it("自分のレビューを取得できる", async () => {
    const s = setup();
    const [id] = await seedReviews(s, [WEEK]);
    const review = await getWeeklyReviewUseCase(
      { reviewRepository: s.reviewRepository },
      { actorUserId: USER_A, reviewId: id ?? "" },
    );
    expect(review.weekStart).toBe(WEEK);
  });

  it("存在しない ID と他人のレビューは区別せず WeeklyReviewNotFoundError", async () => {
    const s = setup();
    const [id] = await seedReviews(s, [WEEK]);
    const deps = { reviewRepository: s.reviewRepository };
    await expect(
      getWeeklyReviewUseCase(deps, { actorUserId: USER_B, reviewId: id ?? "" }),
    ).rejects.toBeInstanceOf(WeeklyReviewNotFoundError);
    await expect(
      getWeeklyReviewUseCase(deps, {
        actorUserId: USER_A,
        reviewId: "10000000-0000-4000-8000-ffffffffffff",
      }),
    ).rejects.toBeInstanceOf(WeeklyReviewNotFoundError);
  });

  it("新しい週の順に返し、limit と cursor でページングする", async () => {
    const s = setup();
    await seedReviews(s, ["2025-12-22", "2026-01-05", "2025-12-29"]);
    const deps = { reviewRepository: s.reviewRepository };

    const page1 = await listWeeklyReviewsUseCase(deps, { actorUserId: USER_A, limit: 2 });
    expect(page1.items.map((item) => item.weekStart)).toEqual(["2026-01-05", "2025-12-29"]);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await listWeeklyReviewsUseCase(deps, {
      actorUserId: USER_A,
      limit: 2,
      cursor: page1.nextCursor ?? undefined,
    });
    expect(page2.items.map((item) => item.weekStart)).toEqual(["2025-12-22"]);
    expect(page2.nextCursor).toBeNull();
  });

  it("ちょうど limit 件なら nextCursor は null、0 件なら空配列", async () => {
    const s = setup();
    await seedReviews(s, ["2025-12-29", "2026-01-05"]);
    const deps = { reviewRepository: s.reviewRepository };
    const exact = await listWeeklyReviewsUseCase(deps, { actorUserId: USER_A, limit: 2 });
    expect(exact.items).toHaveLength(2);
    expect(exact.nextCursor).toBeNull();
    const none = await listWeeklyReviewsUseCase(deps, { actorUserId: USER_B, limit: 2 });
    expect(none).toEqual({ items: [], nextCursor: null });
  });

  it("他ユーザーのレビューは一覧に出ない", async () => {
    const s = setup();
    await seedReviews(s, [WEEK], USER_B);
    const result = await listWeeklyReviewsUseCase(
      { reviewRepository: s.reviewRepository },
      { actorUserId: USER_A, limit: 20 },
    );
    expect(result.items).toEqual([]);
    expect(s.reviewRepository.calls.at(-1)).toEqual({ method: "list", actorUserId: USER_A });
  });

  it.each([
    "!!!",
    "",
    Buffer.from("not json").toString("base64url"),
    Buffer.from(JSON.stringify({ v: 2, w: "2026-01-05" })).toString("base64url"),
    Buffer.from(JSON.stringify({ v: 1, w: "2026-02-30" })).toString("base64url"),
    Buffer.from(JSON.stringify({ v: 1, w: 20260105 })).toString("base64url"),
    Buffer.from(JSON.stringify({ v: 1 })).toString("base64url"),
    Buffer.from(JSON.stringify(null)).toString("base64url"),
    Buffer.from(JSON.stringify([1])).toString("base64url"),
  ])("不正・改ざんされた cursor は InvalidWeeklyReviewCursorError: %s", async (cursor) => {
    const s = setup();
    await expect(
      listWeeklyReviewsUseCase(
        { reviewRepository: s.reviewRepository },
        { actorUserId: USER_A, limit: 20, cursor },
      ),
    ).rejects.toBeInstanceOf(InvalidWeeklyReviewCursorError);
  });
});

describe("weekly review cursor", () => {
  it("encode/decode は往復し、weekStart 以外(user ID など)を含まない", () => {
    const cursor = encodeWeeklyReviewCursor("2026-01-05");
    expect(decodeWeeklyReviewCursor(cursor)).toEqual({ weekStart: "2026-01-05" });
    expect(Buffer.from(cursor, "base64url").toString("utf8")).toBe('{"v":1,"w":"2026-01-05"}');
  });
});

describe("updateWeeklyReviewUseCase", () => {
  async function draft() {
    const s = setup();
    const [id] = await seedReviews(s, [WEEK]);
    const deps = {
      reviewRepository: s.reviewRepository,
      now: () => new Date("2026-01-15T00:00:00Z"),
    };
    return { s, id: id ?? "", deps };
  }

  it("draft の間は振り返りを何度でも更新でき、前後の空白は除去される", async () => {
    const { id, deps } = await draft();
    const first = await updateWeeklyReviewUseCase(deps, {
      actorUserId: USER_A,
      reviewId: id,
      reflection: "  よく続いた  ",
      complete: false,
    });
    expect(first).toMatchObject({ reflection: "よく続いた", status: "draft", completedAt: null });
    const second = await updateWeeklyReviewUseCase(deps, {
      actorUserId: USER_A,
      reviewId: id,
      reflection: "来週も続ける",
      complete: false,
    });
    expect(second.reflection).toBe("来週も続ける");
  });

  it("reflection を省略すると変更しない。null・空白のみはクリアする", async () => {
    const { id, deps } = await draft();
    await updateWeeklyReviewUseCase(deps, {
      actorUserId: USER_A,
      reviewId: id,
      reflection: "メモ",
      complete: false,
    });
    const reflectionKept = await updateWeeklyReviewUseCase(deps, {
      actorUserId: USER_A,
      reviewId: id,
      complete: false,
      reflection: undefined,
    }).catch((e: unknown) => e);
    // 何も指定しない更新は拒否(状態は変わらない)
    expect(reflectionKept).toBeInstanceOf(InvalidWeeklyReviewError);

    const cleared = await updateWeeklyReviewUseCase(deps, {
      actorUserId: USER_A,
      reviewId: id,
      reflection: "   ",
      complete: false,
    });
    expect(cleared.reflection).toBeNull();
  });

  it("確定すると completed、completedAt が設定され、reflection も同時に保存できる", async () => {
    const { id, deps } = await draft();
    const completed = await updateWeeklyReviewUseCase(deps, {
      actorUserId: USER_A,
      reviewId: id,
      reflection: "振り返り",
      complete: true,
    });
    expect(completed).toMatchObject({ status: "completed", reflection: "振り返り" });
    expect(completed.completedAt).toEqual(new Date("2026-01-15T00:00:00Z"));
  });

  it("reflection を変えずに確定すると既存の振り返りが保持される", async () => {
    const { id, deps } = await draft();
    await updateWeeklyReviewUseCase(deps, {
      actorUserId: USER_A,
      reviewId: id,
      reflection: "下書き",
      complete: false,
    });
    const completed = await updateWeeklyReviewUseCase(deps, {
      actorUserId: USER_A,
      reviewId: id,
      complete: true,
    });
    expect(completed.reflection).toBe("下書き");
  });

  it("確定後は reflection の更新・再確定のどちらも WeeklyReviewAlreadyCompletedError で、内容は変わらない", async () => {
    const { s, id, deps } = await draft();
    await updateWeeklyReviewUseCase(deps, {
      actorUserId: USER_A,
      reviewId: id,
      reflection: "確定時",
      complete: true,
    });
    await expect(
      updateWeeklyReviewUseCase(deps, {
        actorUserId: USER_A,
        reviewId: id,
        reflection: "追記",
        complete: false,
      }),
    ).rejects.toBeInstanceOf(WeeklyReviewAlreadyCompletedError);
    await expect(
      updateWeeklyReviewUseCase(deps, { actorUserId: USER_A, reviewId: id, complete: true }),
    ).rejects.toBeInstanceOf(WeeklyReviewAlreadyCompletedError);
    expect(s.reviewRepository.reviews.get(`${USER_A}:${WEEK}`)?.reflection).toBe("確定時");
  });

  it("他人のレビュー・存在しない ID は WeeklyReviewNotFoundError で、何も変更しない", async () => {
    const { s, id, deps } = await draft();
    await expect(
      updateWeeklyReviewUseCase(deps, {
        actorUserId: USER_B,
        reviewId: id,
        reflection: "乗っ取り",
        complete: true,
      }),
    ).rejects.toBeInstanceOf(WeeklyReviewNotFoundError);
    await expect(
      updateWeeklyReviewUseCase(deps, {
        actorUserId: USER_A,
        reviewId: "10000000-0000-4000-8000-ffffffffffff",
        complete: true,
      }),
    ).rejects.toBeInstanceOf(WeeklyReviewNotFoundError);
    expect(s.reviewRepository.reviews.get(`${USER_A}:${WEEK}`)).toMatchObject({
      status: "draft",
      reflection: null,
    });
  });

  it("1001 文字(空白除去後)の reflection は InvalidWeeklyReviewError で、repository を呼ばない", async () => {
    const { s, id, deps } = await draft();
    const before = s.reviewRepository.calls.length;
    await expect(
      updateWeeklyReviewUseCase(deps, {
        actorUserId: USER_A,
        reviewId: id,
        reflection: "x".repeat(1001),
        complete: false,
      }),
    ).rejects.toBeInstanceOf(InvalidWeeklyReviewError);
    expect(s.reviewRepository.calls.length).toBe(before);
  });
});
