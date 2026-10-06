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

/** 今日(actor の timezone のローカル日)に予定された習慣と、その日の記録を返す(HENT-001)。 */
export async function getTodayScheduleUseCase(
  deps: GetTodayScheduleDeps,
  input: GetTodayScheduleInput,
): Promise<TodaySchedule> {
  const today = await resolveLocalToday(deps.profileRepository, deps.now, input.actorUserId);
  // user が存在しない(削除済み等)。習慣も存在しない扱いにする。
  if (today === null) throw new HabitNotFoundError();
  const [habits, entries] = await Promise.all([
    listAllActiveHabits(deps.habitRepository, input.actorUserId),
    deps.entryRepository.listByDate({ actorUserId: input.actorUserId, date: today.date }),
  ]);
  const entryByHabitId = new Map(entries.map((entry) => [entry.habitId, entry]));

  const items: TodayScheduleItem[] = [];
  for (const { habit } of habits) {
    const occurrence = scheduledOccurrenceOn(habit.scheduleVersions, today.date);
    if (occurrence === null) continue;
    items.push({
      habit,
      targetCount: occurrence.targetCount,
      entry: entryByHabitId.get(habit.id) ?? null,
    });
  }
  return { date: today.date, timezone: today.timezone, items };
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

  const oldest = addCalendarDays(today.date, -ENTRY_BACKDATE_LIMIT_DAYS);
  if (!isValidCalendarDate(input.date) || input.date < oldest || input.date > today.date) {
    throw new EntryDateOutOfRangeError();
  }

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
