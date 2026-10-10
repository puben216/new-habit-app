import {
  HabitArchivedError,
  addCalendarDays,
  isValidCalendarDate,
  resolveHabitEntry,
  scheduledOccurrenceOn,
} from "@habit-app/domain";
import type { HabitEntryStatus } from "@habit-app/domain";

import type { Clock } from "../auth";
import { HabitNotFoundError } from "../habits/errors";
import type { HabitRecord, HabitRepositoryPort } from "../habits/ports";
import type { ProfileRepositoryPort } from "../identity/ports";
import { resolveLocalToday } from "./local-today";
import { EntryDateOutOfRangeError, HabitNotScheduledError } from "./errors";
import type { HabitEntryRecord, HabitEntryRepositoryPort } from "./ports";

/**
 * tracking の use case(docs/specs/habit-entry.md)。
 * 予定日判定・成功判定は Domain の関数だけが行い、ここでは再実装しない。
 * 「今日」は use case ごとに `now()` を 1 回だけ呼んで求める(日付境界での不整合を避ける)。
 */

/** 今日から遡って記録できる日数(HENT-INV-005。この定数が唯一の定義)。 */
export const ENTRY_BACKDATE_LIMIT_DAYS = 7;

/** 1 回の取得で habits を走査するときのページサイズ。 */
const HABIT_PAGE_SIZE = 100;

export interface TodayScheduleItem {
  readonly habit: HabitRecord["habit"];
  readonly targetCount: number;
  readonly entry: HabitEntryRecord | null;
}

export interface TodaySchedule {
  readonly date: string;
  readonly timezone: string;
  /** 記録を補正できる最も古い暦日(今日から `ENTRY_BACKDATE_LIMIT_DAYS` 日前)。client が日数を再定義しないために返す。 */
  readonly earliestDate: string;
  readonly items: readonly TodayScheduleItem[];
}

export interface GetTodayScheduleDeps {
  readonly habitRepository: HabitRepositoryPort;
  readonly entryRepository: HabitEntryRepositoryPort;
  readonly profileRepository: ProfileRepositoryPort;
  readonly now: Clock;
}

export interface GetTodayScheduleInput {
  readonly actorUserId: string;
}

/** active な習慣をすべて、作成が古い順に取得する(list は新しい順のため反転する)。 */
export async function listAllActiveHabits(
  habitRepository: HabitRepositoryPort,
  actorUserId: string,
): Promise<readonly HabitRecord[]> {
  const collected: HabitRecord[] = [];
  let afterHabitId: string | null = null;
  for (;;) {
    const result = await habitRepository.list({
      actorUserId,
      status: "active",
      limit: HABIT_PAGE_SIZE,
      afterHabitId,
    });
    if (!result.ok) break;
    collected.push(...result.items);
    const last = result.items[result.items.length - 1];
    if (result.items.length < HABIT_PAGE_SIZE || last === undefined) break;
    afterHabitId = last.habit.id;
  }
  return collected.reverse();
}

/** 対象日が「今日から過去 7 日前まで」に収まることを確認する(HENT-004。upsert と予定取得で共有)。 */
function assertEntryDateInRange(todayDate: string, date: string): void {
  const oldest = addCalendarDays(todayDate, -ENTRY_BACKDATE_LIMIT_DAYS);
  if (!isValidCalendarDate(date) || date < oldest || date > todayDate) {
    throw new EntryDateOutOfRangeError();
  }
}

async function buildSchedule(
  deps: GetTodayScheduleDeps,
  actorUserId: string,
  timezone: string,
  todayDate: string,
  date: string,
): Promise<TodaySchedule> {
  const [habits, entries] = await Promise.all([
    listAllActiveHabits(deps.habitRepository, actorUserId),
    deps.entryRepository.listByDate({ actorUserId, date }),
  ]);
  const entryByHabitId = new Map(entries.map((entry) => [entry.habitId, entry]));

  const items: TodayScheduleItem[] = [];
  for (const { habit } of habits) {
    const occurrence = scheduledOccurrenceOn(habit.scheduleVersions, date);
    if (occurrence === null) continue;
    items.push({
      habit,
      targetCount: occurrence.targetCount,
      entry: entryByHabitId.get(habit.id) ?? null,
    });
  }
  return {
    date,
    timezone,
    earliestDate: addCalendarDays(todayDate, -ENTRY_BACKDATE_LIMIT_DAYS),
    items,
  };
}

/** 今日(actor の timezone のローカル日)に予定された習慣と、その日の記録を返す(HENT-001)。 */
export async function getTodayScheduleUseCase(
  deps: GetTodayScheduleDeps,
  input: GetTodayScheduleInput,
): Promise<TodaySchedule> {
  const today = await resolveLocalToday(deps.profileRepository, deps.now, input.actorUserId);
  // user が存在しない(削除済み等)。習慣も存在しない扱いにする。
  if (today === null) throw new HabitNotFoundError();
  return buildSchedule(deps, input.actorUserId, today.timezone, today.date, today.date);
}

export interface GetScheduleOnDateInput {
  readonly actorUserId: string;
  /** 対象日(`YYYY-MM-DD`)。今日から過去 7 日前までの範囲(docs/specs/today-screens.md TUI-005)。 */
  readonly date: string;
}

/**
 * 指定日(今日から過去 7 日前まで)に予定された習慣と、その日の記録を返す。過去の記録の補正画面用。
 *
 * @throws {EntryDateOutOfRangeError} 対象日が範囲外または実在しない暦日
 * @throws {HabitNotFoundError} actor の user が存在しない
 */
export async function getScheduleOnDateUseCase(
  deps: GetTodayScheduleDeps,
  input: GetScheduleOnDateInput,
): Promise<TodaySchedule> {
  const today = await resolveLocalToday(deps.profileRepository, deps.now, input.actorUserId);
  if (today === null) throw new HabitNotFoundError();
  assertEntryDateInRange(today.date, input.date);
  return buildSchedule(deps, input.actorUserId, today.timezone, today.date, input.date);
}

export interface UpsertHabitEntryDeps {
  readonly habitRepository: HabitRepositoryPort;
  readonly entryRepository: HabitEntryRepositoryPort;
  readonly profileRepository: ProfileRepositoryPort;
  readonly now: Clock;
}

export interface UpsertHabitEntryInput {
  readonly actorUserId: string;
  readonly habitId: string;
  /** 対象日(`YYYY-MM-DD`)。形式は Presentation(contract)で検証済みだが、暦日の実在はここでも確認する。 */
  readonly date: string;
  readonly status: HabitEntryStatus;
  readonly quantity?: number | null | undefined;
}

/**
 * 記録を冪等に作成・訂正する(HENT-002〜004)。
 *
 * @throws {HabitNotFoundError} 習慣が存在しない、または actor のものではない
 * @throws {HabitArchivedError} 習慣がアーカイブ済み
 * @throws {EntryDateOutOfRangeError} 対象日が今日から過去 7 日の範囲外
 * @throws {HabitNotScheduledError} 対象日に予定機会がない
 * @throws {InvalidHabitEntryError} status/quantity が kind と目標回数に対して不整合
 */
export async function upsertHabitEntryUseCase(
  deps: UpsertHabitEntryDeps,
  input: UpsertHabitEntryInput,
): Promise<HabitEntryRecord> {
  const today = await resolveLocalToday(deps.profileRepository, deps.now, input.actorUserId);
  // user が存在しない(削除済み等)。習慣も存在しない扱いにする。
  if (today === null) throw new HabitNotFoundError();

  assertEntryDateInRange(today.date, input.date);

  const record = await deps.habitRepository.findById({
    actorUserId: input.actorUserId,
    habitId: input.habitId,
  });
  if (record === null) throw new HabitNotFoundError();
  if (record.habit.status === "archived") throw new HabitArchivedError("habit is archived");

  const occurrence = scheduledOccurrenceOn(record.habit.scheduleVersions, input.date);
  if (occurrence === null) throw new HabitNotScheduledError();

  const resolved = resolveHabitEntry(record.habit.kind, occurrence.targetCount, {
    status: input.status,
    quantity: input.quantity,
  });

  const saved = await deps.entryRepository.upsert({
    actorUserId: input.actorUserId,
    habitId: input.habitId,
    date: input.date,
    status: resolved.status,
    quantity: resolved.quantity,
    now: deps.now(),
  });
  // 検証後に習慣が削除された競合。存在しないものとして扱う。
  if (saved === null) throw new HabitNotFoundError();
  return saved;
}

export interface HasUnrecordedScheduledHabitsDeps {
  readonly habitRepository: HabitRepositoryPort;
  readonly entryRepository: HabitEntryRepositoryPort;
}

/**
 * 指定した日に予定された active な習慣のうち、記録(`success`/`missed`/`skipped` のいずれか)が
 * まだない習慣があるか。通知(T-402)が「記録済みなら送らない」を判定するための公開 API。
 * 予定された習慣がなければ `false`。
 */
export async function hasUnrecordedScheduledHabitsUseCase(
  deps: HasUnrecordedScheduledHabitsDeps,
  input: { readonly actorUserId: string; readonly date: string },
): Promise<boolean> {
  const [habits, entries] = await Promise.all([
    listAllActiveHabits(deps.habitRepository, input.actorUserId),
    deps.entryRepository.listByDate({ actorUserId: input.actorUserId, date: input.date }),
  ]);
  const recorded = new Set(entries.map((entry) => entry.habitId));
  return habits.some(
    ({ habit }) =>
      scheduledOccurrenceOn(habit.scheduleVersions, input.date) !== null && !recorded.has(habit.id),
  );
}
