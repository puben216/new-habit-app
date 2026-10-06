import { describe, expect, it } from "vitest";

import { archiveHabitUseCase, createHabitUseCase } from "../habits/use-cases";
import { createFakeHabitRepository, createSequentialIdGenerator } from "../habits/test-fakes";
import { createFakeProfileRepository } from "../identity/test-fakes";
import { getDashboardUseCase } from "./dashboard-use-cases";
import { UserNotFoundError } from "./errors";
import { createFakeHabitEntryRepository } from "./test-fakes";
import type { HabitEntryStatus } from "@habit-app/domain";

const USER_A = "1";
const USER_B = "2";
const USER_MISSING = "99";

// 2026-01-14 は水曜。12:00 JST。
const WED_NOON_JST = "2026-01-14T03:00:00Z";

function setup(nowIso: string, timezone = "Asia/Tokyo") {
  const now = new Date(nowIso);
  const clock = () => now;
  const habitRepository = createFakeHabitRepository();
  const idGenerator = createSequentialIdGenerator();
  const profileRepository = createFakeProfileRepository([USER_A, USER_B]);
  for (const userId of [USER_A, USER_B]) {
    profileRepository.seed({
      userId,
      displayName: null,
      timezone,
      locale: "ja",
      weekStartsOn: 1,
      updatedAt: now,
    });
  }
  const entryRepository = createFakeHabitEntryRepository([]);

  async function createHabit(
    actorUserId: string,
    name: string,
    schedule = { effectiveFrom: "2025-01-01", daysOfWeek: [0, 1, 2, 3, 4, 5, 6], targetCount: 1 },
  ): Promise<string> {
    const record = await createHabitUseCase(
      { habitRepository, idGenerator, now: clock },
      {
        actorUserId,
        kind: "build",
        name,
        purpose: "健康維持",
        cue: "起床直後",
        minimumAction: "コップ1杯",
        schedule,
      },
    );
    return record.habit.id;
  }

  function record(
    actorUserId: string,
    habitId: string,
    date: string,
    status: HabitEntryStatus,
  ): void {
    entryRepository.seed(actorUserId, {
      habitId,
      date,
      status,
      quantity: status === "skipped" ? null : status === "success" ? 1 : 0,
      createdAt: now,
      updatedAt: now,
    });
  }

  const deps = () => ({ habitRepository, entryRepository, profileRepository, now: clock });
  return { habitRepository, entryRepository, createHabit, record, deps, clock, idGenerator };
}

describe("getDashboardUseCase", () => {
  it("習慣がなければ habits は空、全体は件数 0 で成功率 null(空状態)", async () => {
    const s = setup(WED_NOON_JST);
    const result = await getDashboardUseCase(s.deps(), { actorUserId: USER_A });
    expect(result.date).toBe("2026-01-14");
    expect(result.timezone).toBe("Asia/Tokyo");
    expect(result.habits).toEqual([]);
    expect(result.overall.last7Days).toEqual({
      from: "2026-01-08",
      to: "2026-01-14",
      scheduled: 0,
      success: 0,
      missed: 0,
      skipped: 0,
      pending: 0,
      successRate: null,
    });
    expect(result.overall.last30Days.from).toBe("2025-12-16");
  });

  it("習慣ごとの統計を作成が古い順に返し、全体は合計から成功率を求める", async () => {
    const s = setup(WED_NOON_JST);
    const a = await s.createHabit(USER_A, "A", {
      effectiveFrom: "2026-01-13",
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      targetCount: 1,
    });
    const b = await s.createHabit(USER_A, "B", {
      effectiveFrom: "2026-01-11",
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      targetCount: 1,
    });
    // A: 1/13 success(今日 1/14 は未記録 = pending)
    s.record(USER_A, a, "2026-01-13", "success");
    // B: 1/11 success, 1/12 missed, 1/13 missed, 今日 success
    s.record(USER_A, b, "2026-01-11", "success");
    s.record(USER_A, b, "2026-01-12", "missed");
    s.record(USER_A, b, "2026-01-14", "success");

    const result = await getDashboardUseCase(s.deps(), { actorUserId: USER_A });

    expect(result.habits.map((h) => h.habit.name)).toEqual(["A", "B"]);
    expect(result.habits[0]?.statistics).toMatchObject({
      currentStreak: 1,
      longestStreak: 1,
      last7Days: { scheduled: 2, success: 1, pending: 1, successRate: 1 },
    });
    expect(result.habits[1]?.statistics).toMatchObject({
      currentStreak: 1,
      longestStreak: 1,
      last7Days: { scheduled: 4, success: 2, missed: 2, successRate: 0.5 },
    });
    // 全体は 合計 success 3 / (3 + missed 2) = 0.6(率の平均 0.75 ではない)
    expect(result.overall.last7Days).toMatchObject({
      scheduled: 6,
      success: 3,
      missed: 2,
      pending: 1,
      successRate: 0.6,
    });
  });

  it("「今日」は actor の timezone のローカル日で決まる(UTC では前日でも 1/14)", async () => {
    // 2026-01-13T20:00:00Z は UTC では 1/13、Asia/Tokyo では 1/14 05:00
    const s = setup("2026-01-13T20:00:00Z", "Asia/Tokyo");
    const result = await getDashboardUseCase(s.deps(), { actorUserId: USER_A });
    expect(result.date).toBe("2026-01-14");
    expect(result.overall.last7Days.from).toBe("2026-01-08");
    expect(result.overall.last7Days.to).toBe("2026-01-14");
  });

  it("DST 日: America/New_York の 2026-03-08 23:30 は 3/8 として集計する", async () => {
    const s = setup("2026-03-09T03:30:00Z", "America/New_York");
    const result = await getDashboardUseCase(s.deps(), { actorUserId: USER_A });
    expect(result.date).toBe("2026-03-08");
    expect(result.overall.last7Days.to).toBe("2026-03-08");
  });

  it("アーカイブ済み習慣は habits にも全体にも含めない", async () => {
    const s = setup(WED_NOON_JST);
    const active = await s.createHabit(USER_A, "active");
    const archived = await s.createHabit(USER_A, "archived");
    s.record(USER_A, active, "2026-01-13", "success");
    s.record(USER_A, archived, "2026-01-13", "success");
    await archiveHabitUseCase(
      { habitRepository: s.habitRepository, now: s.clock },
      { actorUserId: USER_A, habitId: archived, version: 1 },
    );

    const result = await getDashboardUseCase(s.deps(), { actorUserId: USER_A });
    expect(result.habits.map((h) => h.habit.name)).toEqual(["active"]);
    expect(result.overall.last7Days.success).toBe(1);
  });

  it("他ユーザーの習慣・記録は含めない", async () => {
    const s = setup(WED_NOON_JST);
    const mine = await s.createHabit(USER_A, "mine");
    const theirs = await s.createHabit(USER_B, "theirs");
    s.record(USER_A, mine, "2026-01-13", "success");
    s.record(USER_B, theirs, "2026-01-13", "success");
    s.record(USER_B, theirs, "2026-01-12", "success");

    const result = await getDashboardUseCase(s.deps(), { actorUserId: USER_A });
    expect(result.habits.map((h) => h.habit.name)).toEqual(["mine"]);
    expect(result.overall.last7Days.success).toBe(1);
  });

  it("すべての repository 呼び出しに actor が渡り、記録の取得は習慣数に依らず 1 回", async () => {
    const s = setup(WED_NOON_JST);
    for (const name of ["h1", "h2", "h3", "h4"]) await s.createHabit(USER_A, name);

    await getDashboardUseCase(s.deps(), { actorUserId: USER_A });

    const entryCalls = s.entryRepository.calls;
    expect(entryCalls).toEqual([{ method: "listByDateRange", actorUserId: USER_A }]);
    const listCalls = s.habitRepository.calls.filter((c) => c.method === "list");
    expect(listCalls.length).toBe(1);
    expect(
      s.habitRepository.calls
        .filter((c) => c.method === "list" || c.method === "findById")
        .every((c) => c.actorUserId === USER_A),
    ).toBe(true);
  });

  it("user が存在しなければ UserNotFoundError", async () => {
    const s = setup(WED_NOON_JST);
    await expect(
      getDashboardUseCase(s.deps(), { actorUserId: USER_MISSING }),
    ).rejects.toBeInstanceOf(UserNotFoundError);
  });
});
