import { HabitArchivedError, InvalidHabitEntryError } from "@habit-app/domain";
import { describe, expect, it } from "vitest";

import { archiveHabitUseCase, createHabitUseCase } from "../habits/use-cases";
import { HabitNotFoundError } from "../habits/errors";
import { createFakeHabitRepository, createSequentialIdGenerator } from "../habits/test-fakes";
import { createFakeProfileRepository } from "../identity/test-fakes";
import { EntryDateOutOfRangeError, HabitNotScheduledError } from "./errors";
import { createFakeHabitEntryRepository } from "./test-fakes";
import type { FakeHabitEntryRepository } from "./test-fakes";
import {
  ENTRY_BACKDATE_LIMIT_DAYS,
  getScheduleOnDateUseCase,
  getTodayScheduleUseCase,
  upsertHabitEntryUseCase,
} from "./use-cases";

const USER_A = "1";
const USER_B = "2";

interface Setup {
  now: { current: Date };
  habitRepository: ReturnType<typeof createFakeHabitRepository>;
  entryRepository: FakeHabitEntryRepository;
  profileRepository: ReturnType<typeof createFakeProfileRepository>;
  createHabit(
    actorUserId: string,
    overrides?: Partial<Parameters<typeof createHabitUseCase>[1]>,
  ): Promise<string>;
  upsertDeps(): Parameters<typeof upsertHabitEntryUseCase>[0];
  todayDeps(): Parameters<typeof getTodayScheduleUseCase>[0];
}

/** 呼び出し側が選べる固定 Clock と fake 群。 */
function setup(nowIso: string, timezone = "Asia/Tokyo"): Setup {
  const now = { current: new Date(nowIso) };
  const habitRepository = createFakeHabitRepository();
  const idGenerator = createSequentialIdGenerator();
  const profileRepository = createFakeProfileRepository([USER_A, USER_B]);
  profileRepository.seed({
    userId: USER_A,
    displayName: null,
    timezone,
    locale: "ja",
    weekStartsOn: 1,
    updatedAt: new Date(nowIso),
  });
  const owned: { actorUserId: string; habitId: string }[] = [];
  const entryRepository = createFakeHabitEntryRepository(owned);
  const clock = () => now.current;

  return {
    now,
    habitRepository,
    entryRepository,
    profileRepository,
    async createHabit(actorUserId, overrides = {}) {
      const record = await createHabitUseCase(
        { habitRepository, idGenerator, now: clock },
        {
          actorUserId,
          kind: "build",
          name: "水を飲む",
          purpose: "健康維持",
          cue: "起床直後",
          minimumAction: "コップ1杯",
          // 全曜日・十分過去から有効
          schedule: {
            effectiveFrom: "2025-01-01",
            daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
            targetCount: 1,
          },
          ...overrides,
        },
      );
      owned.push({ actorUserId, habitId: record.habit.id });
      return record.habit.id;
    },
    upsertDeps: () => ({ habitRepository, entryRepository, profileRepository, now: clock }),
    todayDeps: () => ({ habitRepository, entryRepository, profileRepository, now: clock }),
  };
}

// 2026-01-14 は水曜
const WED_NOON_JST = "2026-01-14T03:00:00Z";

describe("upsertHabitEntryUseCase", () => {
  it("今日の記録を作成し、同じ日の再送・訂正は上書きで 1 件のまま", async () => {
    const s = setup(WED_NOON_JST);
    const habitId = await s.createHabit(USER_A);
    const base = { actorUserId: USER_A, habitId, date: "2026-01-14" };

    const created = await upsertHabitEntryUseCase(s.upsertDeps(), { ...base, status: "missed" });
    expect(created).toMatchObject({ habitId, date: "2026-01-14", status: "missed", quantity: 0 });

    const corrected = await upsertHabitEntryUseCase(s.upsertDeps(), { ...base, status: "success" });
    expect(corrected).toMatchObject({ status: "success", quantity: 1 });

    const again = await upsertHabitEntryUseCase(s.upsertDeps(), { ...base, status: "success" });
    expect(again).toEqual(corrected);
    expect(s.entryRepository.entries.size).toBe(1);
  });

  it("対象日の範囲: 今日と 7 日前は受理、未来日と 8 日前は拒否", async () => {
    const s = setup(WED_NOON_JST);
    const habitId = await s.createHabit(USER_A);
    const input = { actorUserId: USER_A, habitId, status: "success" as const };
    expect(ENTRY_BACKDATE_LIMIT_DAYS).toBe(7);

    await expect(
      upsertHabitEntryUseCase(s.upsertDeps(), { ...input, date: "2026-01-14" }),
    ).resolves.toBeDefined();
    await expect(
      upsertHabitEntryUseCase(s.upsertDeps(), { ...input, date: "2026-01-07" }),
    ).resolves.toBeDefined();
    await expect(
      upsertHabitEntryUseCase(s.upsertDeps(), { ...input, date: "2026-01-06" }),
    ).rejects.toBeInstanceOf(EntryDateOutOfRangeError);
    await expect(
      upsertHabitEntryUseCase(s.upsertDeps(), { ...input, date: "2026-01-15" }),
    ).rejects.toBeInstanceOf(EntryDateOutOfRangeError);
    await expect(
      upsertHabitEntryUseCase(s.upsertDeps(), { ...input, date: "2026-02-30" }),
    ).rejects.toBeInstanceOf(EntryDateOutOfRangeError);
  });

  it("「今日」は actor の timezone のローカル日で決まる(UTC では前日でも未来日にならない)", async () => {
    // 2026-01-13T20:00:00Z は UTC では 1/13、Asia/Tokyo では 1/14 05:00
    const s = setup("2026-01-13T20:00:00Z", "Asia/Tokyo");
    const habitId = await s.createHabit(USER_A);
    await expect(
      upsertHabitEntryUseCase(s.upsertDeps(), {
        actorUserId: USER_A,
        habitId,
        date: "2026-01-14",
        status: "success",
      }),
    ).resolves.toBeDefined();
  });

  it("DST 日: America/New_York の 2026-03-08 23:30 は 3/8 として扱う", async () => {
    const s = setup("2026-03-09T03:30:00Z", "America/New_York");
    const habitId = await s.createHabit(USER_A);
    await expect(
      upsertHabitEntryUseCase(s.upsertDeps(), {
        actorUserId: USER_A,
        habitId,
        date: "2026-03-08",
        status: "success",
      }),
    ).resolves.toBeDefined();
    await expect(
      upsertHabitEntryUseCase(s.upsertDeps(), {
        actorUserId: USER_A,
        habitId,
        date: "2026-03-09",
        status: "success",
      }),
    ).rejects.toBeInstanceOf(EntryDateOutOfRangeError);
  });

  it("予定のない日(曜日が対象外・有効期間外)は拒否する", async () => {
    const s = setup(WED_NOON_JST);
    // 月・水のみ。2026-01-14 は水、1/13 は火、1/12 は月。effectiveFrom は 1/13 から。
    const habitId = await s.createHabit(USER_A, {
      schedule: { effectiveFrom: "2026-01-13", daysOfWeek: [1, 3], targetCount: 1 },
    });
    const input = { actorUserId: USER_A, habitId, status: "success" as const };
    await expect(
      upsertHabitEntryUseCase(s.upsertDeps(), { ...input, date: "2026-01-14" }),
    ).resolves.toBeDefined();
    await expect(
      upsertHabitEntryUseCase(s.upsertDeps(), { ...input, date: "2026-01-13" }),
    ).rejects.toBeInstanceOf(HabitNotScheduledError); // 火曜
    await expect(
      upsertHabitEntryUseCase(s.upsertDeps(), { ...input, date: "2026-01-12" }),
    ).rejects.toBeInstanceOf(HabitNotScheduledError); // 月曜だが有効期間前
  });

  it("build の目標回数に対する status/quantity の不整合を拒否する", async () => {
    const s = setup(WED_NOON_JST);
    const habitId = await s.createHabit(USER_A, {
      schedule: { effectiveFrom: "2025-01-01", daysOfWeek: [0, 1, 2, 3, 4, 5, 6], targetCount: 3 },
    });
    const base = { actorUserId: USER_A, habitId, date: "2026-01-14" };
    await expect(
      upsertHabitEntryUseCase(s.upsertDeps(), { ...base, status: "success", quantity: 2 }),
    ).rejects.toBeInstanceOf(InvalidHabitEntryError);
    const missed = await upsertHabitEntryUseCase(s.upsertDeps(), {
      ...base,
      status: "missed",
      quantity: 2,
    });
    expect(missed.quantity).toBe(2);
    const success = await upsertHabitEntryUseCase(s.upsertDeps(), { ...base, status: "success" });
    expect(success.quantity).toBe(3);
  });

  it("reduce は status のみ。quantity 指定は拒否", async () => {
    const s = setup(WED_NOON_JST);
    const habitId = await s.createHabit(USER_A, {
      kind: "reduce",
      schedule: { effectiveFrom: "2025-01-01", daysOfWeek: [0, 1, 2, 3, 4, 5, 6], targetCount: 1 },
    });
    const base = { actorUserId: USER_A, habitId, date: "2026-01-14" };
    await expect(
      upsertHabitEntryUseCase(s.upsertDeps(), { ...base, status: "success", quantity: 1 }),
    ).rejects.toBeInstanceOf(InvalidHabitEntryError);
    const ok = await upsertHabitEntryUseCase(s.upsertDeps(), { ...base, status: "success" });
    expect(ok.quantity).toBeNull();
  });

  it("他ユーザーの習慣・存在しない習慣は NotFound で何も書かない", async () => {
    const s = setup(WED_NOON_JST);
    const habitId = await s.createHabit(USER_A);
    await expect(
      upsertHabitEntryUseCase(s.upsertDeps(), {
        actorUserId: USER_B,
        habitId,
        date: "2026-01-14",
        status: "success",
      }),
    ).rejects.toBeInstanceOf(HabitNotFoundError);
    await expect(
      upsertHabitEntryUseCase(s.upsertDeps(), {
        actorUserId: USER_A,
        habitId: "00000000-0000-4000-8000-ffffffffffff",
        date: "2026-01-14",
        status: "success",
      }),
    ).rejects.toBeInstanceOf(HabitNotFoundError);
    expect(s.entryRepository.entries.size).toBe(0);
  });

  it("アーカイブ済みの習慣は拒否する", async () => {
    const s = setup(WED_NOON_JST);
    const habitId = await s.createHabit(USER_A);
    await archiveHabitUseCase(
      { habitRepository: s.habitRepository, now: () => s.now.current },
      { actorUserId: USER_A, habitId, version: 1 },
    );
    await expect(
      upsertHabitEntryUseCase(s.upsertDeps(), {
        actorUserId: USER_A,
        habitId,
        date: "2026-01-14",
        status: "success",
      }),
    ).rejects.toBeInstanceOf(HabitArchivedError);
  });

  it("repository への全呼び出しに actor が渡る", async () => {
    const s = setup(WED_NOON_JST);
    const habitId = await s.createHabit(USER_A);
    await upsertHabitEntryUseCase(s.upsertDeps(), {
      actorUserId: USER_A,
      habitId,
      date: "2026-01-14",
      status: "success",
    });
    for (const call of [...s.habitRepository.calls, ...s.entryRepository.calls]) {
      expect(call.actorUserId).toBe(USER_A);
    }
    expect(s.entryRepository.calls.some((c) => c.method === "upsert")).toBe(true);
  });
});

describe("getTodayScheduleUseCase", () => {
  it("今日(ローカル日)に予定された active な習慣だけを、作成が古い順に返す", async () => {
    // 2026-01-14(水)
    const s = setup(WED_NOON_JST);
    const first = await s.createHabit(USER_A, { name: "first" });
    await s.createHabit(USER_A, {
      name: "monday-only",
      schedule: { effectiveFrom: "2025-01-01", daysOfWeek: [1], targetCount: 1 },
    });
    const third = await s.createHabit(USER_A, {
      name: "third",
      schedule: { effectiveFrom: "2025-01-01", daysOfWeek: [3], targetCount: 2 },
    });
    const archived = await s.createHabit(USER_A, { name: "archived" });
    await archiveHabitUseCase(
      { habitRepository: s.habitRepository, now: () => s.now.current },
      { actorUserId: USER_A, habitId: archived, version: 1 },
    );

    const today = await getTodayScheduleUseCase(s.todayDeps(), { actorUserId: USER_A });
    expect(today.date).toBe("2026-01-14");
    expect(today.timezone).toBe("Asia/Tokyo");
    expect(today.items.map((i) => i.habit.id)).toEqual([first, third]);
    expect(today.items.map((i) => i.targetCount)).toEqual([1, 2]);
    expect(today.items.every((i) => i.entry === null)).toBe(true);
  });

  it("今日の記録を結合し、他の日や他ユーザーの記録は含めない", async () => {
    const s = setup(WED_NOON_JST);
    const habitId = await s.createHabit(USER_A);
    await upsertHabitEntryUseCase(s.upsertDeps(), {
      actorUserId: USER_A,
      habitId,
      date: "2026-01-13",
      status: "success",
    });
    let today = await getTodayScheduleUseCase(s.todayDeps(), { actorUserId: USER_A });
    expect(today.items[0]?.entry).toBeNull();

    await upsertHabitEntryUseCase(s.upsertDeps(), {
      actorUserId: USER_A,
      habitId,
      date: "2026-01-14",
      status: "success",
    });
    today = await getTodayScheduleUseCase(s.todayDeps(), { actorUserId: USER_A });
    expect(today.items[0]?.entry).toMatchObject({ status: "success", quantity: 1 });

    // 他ユーザーの記録が同じ習慣 ID で混ざらない(fake は actor ごとに分離)
    s.entryRepository.seed(USER_B, {
      habitId,
      date: "2026-01-14",
      status: "missed",
      quantity: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    today = await getTodayScheduleUseCase(s.todayDeps(), { actorUserId: USER_A });
    expect(today.items[0]?.entry?.status).toBe("success");
  });

  it("timezone によって「今日」が変わる(UTC の前日がローカルでは翌日)", async () => {
    // 2026-01-14T20:00:00Z: UTC は水曜、Asia/Tokyo では 1/15(木) 05:00
    const s = setup("2026-01-14T20:00:00Z", "Asia/Tokyo");
    await s.createHabit(USER_A, {
      name: "wed-only",
      schedule: { effectiveFrom: "2025-01-01", daysOfWeek: [3], targetCount: 1 },
    });
    const today = await getTodayScheduleUseCase(s.todayDeps(), { actorUserId: USER_A });
    expect(today.date).toBe("2026-01-15");
    expect(today.items).toEqual([]);
  });

  it("DST 日: America/New_York の 2026-03-08 23:30 は 3/8", async () => {
    const s = setup("2026-03-09T03:30:00Z", "America/New_York");
    const today = await getTodayScheduleUseCase(s.todayDeps(), { actorUserId: USER_A });
    expect(today.date).toBe("2026-03-08");
  });

  it("習慣がなければ空配列", async () => {
    const s = setup(WED_NOON_JST);
    const today = await getTodayScheduleUseCase(s.todayDeps(), { actorUserId: USER_A });
    expect(today.items).toEqual([]);
  });

  it("100 件を超える習慣でもページをまたいで全件走査する", async () => {
    const s = setup(WED_NOON_JST);
    for (let i = 0; i < 105; i += 1) await s.createHabit(USER_A, { name: `h${i}` });
    const today = await getTodayScheduleUseCase(s.todayDeps(), { actorUserId: USER_A });
    expect(today.items).toHaveLength(105);
    expect(today.items[0]?.habit.name).toBe("h0");
  });

  it("プロフィール未作成のユーザーは既定の timezone で遅延作成される", async () => {
    const s = setup(WED_NOON_JST);
    const today = await getTodayScheduleUseCase(s.todayDeps(), { actorUserId: USER_B });
    expect(today.timezone).toBe("Asia/Tokyo");
  });

  it("存在しない user は NotFound", async () => {
    const s = setup(WED_NOON_JST);
    await expect(
      getTodayScheduleUseCase(s.todayDeps(), { actorUserId: "999" }),
    ).rejects.toBeInstanceOf(HabitNotFoundError);
  });
});

describe("getTodayScheduleUseCase: earliestDate", () => {
  it("earliestDate は今日から ENTRY_BACKDATE_LIMIT_DAYS 日前のローカル暦日", async () => {
    const s = setup(WED_NOON_JST);
    const today = await getTodayScheduleUseCase(s.todayDeps(), { actorUserId: USER_A });
    expect(today.date).toBe("2026-01-14");
    expect(today.earliestDate).toBe("2026-01-07");
    expect(ENTRY_BACKDATE_LIMIT_DAYS).toBe(7);
  });
});

describe("getScheduleOnDateUseCase", () => {
  it("指定日(過去)に予定された習慣と、その日の記録だけを返す。date は指定日", async () => {
    // 今日は 2026-01-14(水)。1/12 は月曜。
    const s = setup(WED_NOON_JST);
    const monday = await s.createHabit(USER_A, {
      name: "monday",
      schedule: { effectiveFrom: "2025-01-01", daysOfWeek: [1], targetCount: 2 },
    });
    await s.createHabit(USER_A, {
      name: "wed-only",
      schedule: { effectiveFrom: "2025-01-01", daysOfWeek: [3], targetCount: 1 },
    });
    await upsertHabitEntryUseCase(s.upsertDeps(), {
      actorUserId: USER_A,
      habitId: monday,
      date: "2026-01-12",
      status: "missed",
      quantity: 1,
    });

    const result = await getScheduleOnDateUseCase(s.todayDeps(), {
      actorUserId: USER_A,
      date: "2026-01-12",
    });

    expect(result.date).toBe("2026-01-12");
    expect(result.earliestDate).toBe("2026-01-07");
    expect(result.items.map((i) => i.habit.id)).toEqual([monday]);
    expect(result.items[0]?.targetCount).toBe(2);
    expect(result.items[0]?.entry?.status).toBe("missed");
  });

  it("範囲: 今日と 7 日前は受理、未来日・8 日前・実在しない暦日は拒否", async () => {
    const s = setup(WED_NOON_JST);
    await s.createHabit(USER_A);
    const call = (date: string) =>
      getScheduleOnDateUseCase(s.todayDeps(), { actorUserId: USER_A, date });

    await expect(call("2026-01-14")).resolves.toMatchObject({ date: "2026-01-14" });
    await expect(call("2026-01-07")).resolves.toMatchObject({ date: "2026-01-07" });
    await expect(call("2026-01-15")).rejects.toBeInstanceOf(EntryDateOutOfRangeError);
    await expect(call("2026-01-06")).rejects.toBeInstanceOf(EntryDateOutOfRangeError);
    await expect(call("2026-02-30")).rejects.toBeInstanceOf(EntryDateOutOfRangeError);
  });

  it("「今日」は actor の timezone で決まる(UTC では前日でも 1 日先の範囲が変わる)", async () => {
    // 2026-01-14T16:00Z は Tokyo では 1/15、UTC では 1/14。
    const s = setup("2026-01-14T16:00:00Z", "Asia/Tokyo");
    await expect(
      getScheduleOnDateUseCase(s.todayDeps(), { actorUserId: USER_A, date: "2026-01-15" }),
    ).resolves.toMatchObject({ date: "2026-01-15", earliestDate: "2026-01-08" });
  });

  it("他ユーザーの習慣・記録は含めない", async () => {
    const s = setup(WED_NOON_JST);
    await s.createHabit(USER_B, { name: "b-habit" });
    const result = await getScheduleOnDateUseCase(s.todayDeps(), {
      actorUserId: USER_A,
      date: "2026-01-13",
    });
    expect(result.items).toEqual([]);
  });

  it("アーカイブ済みの習慣は含めない", async () => {
    const s = setup(WED_NOON_JST);
    const archived = await s.createHabit(USER_A);
    await archiveHabitUseCase(
      { habitRepository: s.habitRepository, now: () => s.now.current },
      { actorUserId: USER_A, habitId: archived, version: 1 },
    );
    const result = await getScheduleOnDateUseCase(s.todayDeps(), {
      actorUserId: USER_A,
      date: "2026-01-13",
    });
    expect(result.items).toEqual([]);
  });

  it("user が存在しなければ HabitNotFoundError", async () => {
    const s = setup(WED_NOON_JST);
    await expect(
      getScheduleOnDateUseCase(s.todayDeps(), { actorUserId: "999", date: "2026-01-13" }),
    ).rejects.toBeInstanceOf(HabitNotFoundError);
  });
});
