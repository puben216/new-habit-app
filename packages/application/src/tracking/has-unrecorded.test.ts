import { describe, expect, it } from "vitest";

import { archiveHabitUseCase, createHabitUseCase } from "../habits/use-cases";
import { createFakeHabitRepository, createSequentialIdGenerator } from "../habits/test-fakes";
import { createFakeHabitEntryRepository } from "./test-fakes";
import { hasUnrecordedScheduledHabitsUseCase } from "./use-cases";

const USER_A = "1";
const USER_B = "2";
const NOW = new Date("2026-01-14T03:00:00Z");
const DATE = "2026-01-14"; // 水曜(3)

function setup() {
  const habitRepository = createFakeHabitRepository();
  const idGenerator = createSequentialIdGenerator();
  const owned: { actorUserId: string; habitId: string }[] = [];
  const entryRepository = createFakeHabitEntryRepository(owned);
  const create = async (actorUserId: string, daysOfWeek: number[]) => {
    const record = await createHabitUseCase(
      { habitRepository, idGenerator, now: () => NOW },
      {
        actorUserId,
        kind: "build",
        name: "水を飲む",
        purpose: "健康維持",
        cue: "起床直後",
        minimumAction: "コップ1杯",
        schedule: { effectiveFrom: "2025-01-01", daysOfWeek, targetCount: 1 },
      },
    );
    owned.push({ actorUserId, habitId: record.habit.id });
    return record.habit.id;
  };
  const record = (actorUserId: string, habitId: string, status: "success" | "missed" | "skipped") =>
    entryRepository.upsert({ actorUserId, habitId, date: DATE, status, quantity: null, now: NOW });
  const check = (actorUserId = USER_A) =>
    hasUnrecordedScheduledHabitsUseCase(
      { habitRepository, entryRepository },
      { actorUserId, date: DATE },
    );
  return { habitRepository, idGenerator, create, record, check };
}

describe("hasUnrecordedScheduledHabitsUseCase", () => {
  it("習慣がなければ false", async () => {
    expect(await setup().check()).toBe(false);
  });

  it("その日に予定された習慣に記録がなければ true、記録(success/missed/skipped)があれば false", async () => {
    for (const status of ["success", "missed", "skipped"] as const) {
      const s = setup();
      const habitId = await s.create(USER_A, [3]);
      expect(await s.check()).toBe(true);
      await s.record(USER_A, habitId, status);
      expect(await s.check()).toBe(false);
    }
  });

  it("複数の習慣のうち 1 つでも未記録なら true", async () => {
    const s = setup();
    const first = await s.create(USER_A, [3]);
    await s.create(USER_A, [3]);
    await s.record(USER_A, first, "success");
    expect(await s.check()).toBe(true);
  });

  it("その日に予定のない習慣(曜日が違う)は無視する", async () => {
    const s = setup();
    await s.create(USER_A, [1]); // 月曜のみ
    expect(await s.check()).toBe(false);
  });

  it("アーカイブ済みの習慣は無視する", async () => {
    const s = setup();
    const habitId = await s.create(USER_A, [3]);
    await archiveHabitUseCase(
      { habitRepository: s.habitRepository, now: () => NOW },
      { actorUserId: USER_A, habitId, version: 1 },
    );
    expect(await s.check()).toBe(false);
  });

  it("他ユーザーの習慣・記録は影響しない(A は未記録、B は記録済み)", async () => {
    const s = setup();
    await s.create(USER_A, [3]);
    expect(await s.check(USER_B)).toBe(false);
    const bHabit = await s.create(USER_B, [3]);
    await s.record(USER_B, bHabit, "success");
    expect(await s.check(USER_A)).toBe(true);
    expect(await s.check(USER_B)).toBe(false);
  });
});
