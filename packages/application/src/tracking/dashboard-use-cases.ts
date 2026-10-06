import {
  STATISTICS_WINDOW_DAYS,
  STREAK_LOOKBACK_DAYS,
  addCalendarDays,
  aggregateWindowStatistics,
  calculateHabitStatistics,
} from "@habit-app/domain";
import type { HabitStatistics, WindowStatistics } from "@habit-app/domain";

import type { Clock } from "../auth";
import type { HabitRecord, HabitRepositoryPort } from "../habits/ports";
import type { ProfileRepositoryPort } from "../identity/ports";
import { UserNotFoundError } from "./errors";
import { resolveLocalToday } from "./local-today";
import type { HabitEntryRecord, HabitEntryRepositoryPort } from "./ports";
import { listAllActiveHabits } from "./use-cases";

/**
 * ダッシュボード(統計)の use case(docs/specs/statistics-dashboard.md)。
 * ストリーク・成功率の定義は Domain の `calculateHabitStatistics` だけが持ち、ここでは再実装しない。
 */

export interface DashboardHabit {
  readonly habit: HabitRecord["habit"];
  readonly statistics: HabitStatistics;
}

export interface Dashboard {
  readonly date: string;
  readonly timezone: string;
  readonly overall: {
    readonly last7Days: WindowStatistics;
    readonly last30Days: WindowStatistics;
  };
  /** active な習慣のみ。作成が古い順。 */
  readonly habits: readonly DashboardHabit[];
}

export interface GetDashboardDeps {
  readonly habitRepository: HabitRepositoryPort;
  readonly entryRepository: HabitEntryRepositoryPort;
  readonly profileRepository: ProfileRepositoryPort;
  readonly now: Clock;
}

export interface GetDashboardInput {
  readonly actorUserId: string;
}

/**
 * actor の習慣ごとのストリーク・直近 7/30 日の成功率と、全体の成功率を返す(STAT-001〜005)。
 * 記録は習慣数に依らず 1 回の範囲取得で得る。アーカイブ済み習慣は集計に含めない。
 *
 * @throws {UserNotFoundError} actor の user が存在しない
 */
export async function getDashboardUseCase(
  deps: GetDashboardDeps,
  input: GetDashboardInput,
): Promise<Dashboard> {
  const today = await resolveLocalToday(deps.profileRepository, deps.now, input.actorUserId);
  if (today === null) throw new UserNotFoundError();

  const [habits, entries] = await Promise.all([
    listAllActiveHabits(deps.habitRepository, input.actorUserId),
    deps.entryRepository.listByDateRange({
      actorUserId: input.actorUserId,
      from: addCalendarDays(today.date, -(STREAK_LOOKBACK_DAYS - 1)),
      to: today.date,
    }),
  ]);

  const entriesByHabitId = new Map<string, HabitEntryRecord[]>();
  for (const entry of entries) {
    const list = entriesByHabitId.get(entry.habitId);
    if (list === undefined) entriesByHabitId.set(entry.habitId, [entry]);
    else list.push(entry);
  }

  const dashboardHabits = habits.map(({ habit }): DashboardHabit => ({
    habit,
    statistics: calculateHabitStatistics({
      scheduleVersions: habit.scheduleVersions,
      entries: entriesByHabitId.get(habit.id) ?? [],
      today: today.date,
    }),
  }));

  const period = (days: number) => ({
    from: addCalendarDays(today.date, -(days - 1)),
    to: today.date,
  });
  return {
    date: today.date,
    timezone: today.timezone,
    overall: {
      last7Days: aggregateWindowStatistics(
        period(STATISTICS_WINDOW_DAYS.short),
        dashboardHabits.map((item) => item.statistics.last7Days),
      ),
      last30Days: aggregateWindowStatistics(
        period(STATISTICS_WINDOW_DAYS.long),
        dashboardHabits.map((item) => item.statistics.last30Days),
      ),
    },
    habits: dashboardHabits,
  };
}
