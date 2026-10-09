import {
  InvalidWeeklyReviewError,
  buildWeeklyReviewSummary,
  checkReviewableWeek,
  createDefaultProfile,
  localDateAt,
  normalizeWeeklyReflection,
  weekEndOf,
} from "@habit-app/domain";
import type { StatisticsEntry, WeeklyReviewSummary } from "@habit-app/domain";
import { weeklyReviewSummarySchema } from "@habit-app/contracts";
import type { WeeklyReviewSummaryResponse } from "@habit-app/contracts";

import type { Clock } from "../auth";
import type { HabitRepositoryPort } from "../habits/ports";
import type { ProfileRepositoryPort } from "../identity/ports";
import type { DailyCheckInRepositoryPort } from "./check-in-ports";
import {
  CorruptedWeeklyReviewError,
  ReviewWeekNotAllowedError,
  UserNotFoundError,
  WeeklyReviewAlreadyCompletedError,
  WeeklyReviewNotFoundError,
} from "./errors";
import type { HabitEntryRepositoryPort } from "./ports";
import { listAllActiveHabits } from "./use-cases";
import { decodeWeeklyReviewCursor, encodeWeeklyReviewCursor } from "./weekly-review-cursor";
import type {
  WeeklyReviewRecord,
  WeeklyReviewRepositoryPort,
  WeeklyReviewStatus,
} from "./weekly-review-ports";

/**
 * 週次レビューの use case(docs/specs/weekly-review.md)。
 * 集計・分類の定義は Domain の `buildWeeklyReviewSummary` だけが持ち、ここでは再実装しない。
 */

/** 呼び出し側(Presentation)へ返すレビュー。保存済みスナップショットは schema で検証済み。 */
export interface WeeklyReview {
  readonly id: string;
  readonly weekStart: string;
  readonly weekEnd: string;
  readonly timezone: string;
  readonly status: WeeklyReviewStatus;
  readonly summary: WeeklyReviewSummaryResponse;
  readonly reflection: string | null;
  readonly completedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * 保存済みの記録を検証して返す。スナップショットが `schemaVersion: 1` の形でなければデータ破損として
 * 内部エラーにする(内容はエラーに含めない)。
 */
function toWeeklyReview(record: WeeklyReviewRecord): WeeklyReview {
  const summary = weeklyReviewSummarySchema.safeParse(record.summary);
  if (!summary.success) throw new CorruptedWeeklyReviewError();
  return {
    id: record.id,
    weekStart: record.weekStart,
    weekEnd: weekEndOf(record.weekStart),
    timezone: record.timezone,
    status: record.status,
    summary: summary.data,
    reflection: record.reflection,
    completedAt: record.completedAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export interface CreateWeeklyReviewDeps {
  readonly reviewRepository: WeeklyReviewRepositoryPort;
  readonly habitRepository: HabitRepositoryPort;
  readonly entryRepository: HabitEntryRepositoryPort;
  readonly checkInRepository: DailyCheckInRepositoryPort;
  readonly profileRepository: ProfileRepositoryPort;
  readonly now: Clock;
}

export interface CreateWeeklyReviewInput {
  readonly actorUserId: string;
  readonly weekStart: string;
}

export interface CreateWeeklyReviewResult {
  readonly review: WeeklyReview;
  /** この呼び出しで新規作成したか(false は既存のレビューを返したことを表す)。 */
  readonly created: boolean;
}

/**
 * 終了済みの週のレビューを `draft` で冪等に作成する(WREV-001〜003)。
 * 既存のレビューがあれば再計算せずそのまま返す。習慣数に依らず、記録とチェックインは週 1 回の範囲取得。
 *
 * @throws {UserNotFoundError} actor の user が存在しない
 * @throws {ReviewWeekNotAllowedError} 週の開始日でない・終了していない・古すぎる
 */
export async function createWeeklyReviewUseCase(
  deps: CreateWeeklyReviewDeps,
  input: CreateWeeklyReviewInput,
): Promise<CreateWeeklyReviewResult> {
  const { actorUserId, weekStart } = input;
  const profile = await deps.profileRepository.ensure(actorUserId, createDefaultProfile());
  if (profile === null) throw new UserNotFoundError();

  const now = deps.now();
  const today = localDateAt(now, profile.timezone);
  const check = checkReviewableWeek({ weekStart, today, weekStartsOn: profile.weekStartsOn });
  if (!check.ok) throw new ReviewWeekNotAllowedError(check.reason);

  const existing = await deps.reviewRepository.findByWeekStart({ actorUserId, weekStart });
  if (existing !== null) return { review: toWeeklyReview(existing), created: false };

  const weekEnd = weekEndOf(weekStart);
  const [habits, entries, checkIns] = await Promise.all([
    listAllActiveHabits(deps.habitRepository, actorUserId),
    deps.entryRepository.listByDateRange({ actorUserId, from: weekStart, to: weekEnd }),
    deps.checkInRepository.listByDateRange({ actorUserId, from: weekStart, to: weekEnd }),
  ]);

  const entriesByHabitId = new Map<string, StatisticsEntry[]>();
  for (const entry of entries) {
    const list = entriesByHabitId.get(entry.habitId);
    const item = { date: entry.date, status: entry.status };
    if (list === undefined) entriesByHabitId.set(entry.habitId, [item]);
    else list.push(item);
  }

  const summary: WeeklyReviewSummary = buildWeeklyReviewSummary({
    weekStart,
    today,
    habits: habits.map(({ habit }) => ({
      habitId: habit.id,
      kind: habit.kind,
      name: habit.name,
      scheduleVersions: habit.scheduleVersions,
      entries: entriesByHabitId.get(habit.id) ?? [],
    })),
    checkIns: checkIns.map((checkIn) => ({ mood: checkIn.mood, difficulty: checkIn.difficulty })),
  });

  const saved = await deps.reviewRepository.createIfAbsent({
    actorUserId,
    weekStart,
    timezone: profile.timezone,
    summary,
    now,
  });
  if (saved === null) throw new UserNotFoundError();
  return { review: toWeeklyReview(saved.record), created: saved.created };
}

export interface GetWeeklyReviewDeps {
  readonly reviewRepository: WeeklyReviewRepositoryPort;
}

export interface GetWeeklyReviewInput {
  readonly actorUserId: string;
  readonly reviewId: string;
}

/**
 * 自分のレビューを返す(WREV-004)。
 *
 * @throws {WeeklyReviewNotFoundError} 存在しない、または他ユーザーのレビュー
 */
export async function getWeeklyReviewUseCase(
  deps: GetWeeklyReviewDeps,
  input: GetWeeklyReviewInput,
): Promise<WeeklyReview> {
  const record = await deps.reviewRepository.findById({
    actorUserId: input.actorUserId,
    reviewId: input.reviewId,
  });
  if (record === null) throw new WeeklyReviewNotFoundError();
  return toWeeklyReview(record);
}

export interface ListWeeklyReviewsInput {
  readonly actorUserId: string;
  readonly limit: number;
  readonly cursor?: string | undefined;
}

export interface ListWeeklyReviewsResult {
  readonly items: readonly WeeklyReview[];
  readonly nextCursor: string | null;
}

/**
 * 自分のレビューを `weekStart` の新しい順に返す(WREV-004)。
 *
 * @throws {InvalidWeeklyReviewCursorError} cursor が不正
 */
export async function listWeeklyReviewsUseCase(
  deps: GetWeeklyReviewDeps,
  input: ListWeeklyReviewsInput,
): Promise<ListWeeklyReviewsResult> {
  const beforeWeekStart =
    input.cursor === undefined ? null : decodeWeeklyReviewCursor(input.cursor).weekStart;

  const records = await deps.reviewRepository.list({
    actorUserId: input.actorUserId,
    limit: input.limit + 1,
    beforeWeekStart,
  });
  const page = records.slice(0, input.limit);
  const last = page[page.length - 1];
  const hasMore = records.length > input.limit && last !== undefined;
  return {
    items: page.map(toWeeklyReview),
    nextCursor: hasMore ? encodeWeeklyReviewCursor(last.weekStart) : null,
  };
}

export interface UpdateWeeklyReviewDeps {
  readonly reviewRepository: WeeklyReviewRepositoryPort;
  readonly now: Clock;
}

export interface UpdateWeeklyReviewInput {
  readonly actorUserId: string;
  readonly reviewId: string;
  /** 省略(undefined)は変更しない。null・空白のみはクリア。 */
  readonly reflection?: string | null | undefined;
  /** true で確定する(取り消し不可)。 */
  readonly complete: boolean;
}

/**
 * 振り返りの更新と確定を原子的に行う(WREV-005)。
 *
 * @throws {InvalidWeeklyReviewError} 更新内容がない、または reflection が上限を超える
 * @throws {WeeklyReviewNotFoundError} 存在しない、または他ユーザーのレビュー
 * @throws {WeeklyReviewAlreadyCompletedError} 確定済み
 */
export async function updateWeeklyReviewUseCase(
  deps: UpdateWeeklyReviewDeps,
  input: UpdateWeeklyReviewInput,
): Promise<WeeklyReview> {
  if (input.reflection === undefined && !input.complete) {
    throw new InvalidWeeklyReviewError(
      "update",
      "reflection、status のいずれか 1 つ以上を指定してください。",
    );
  }
  const reflection =
    input.reflection === undefined ? undefined : normalizeWeeklyReflection(input.reflection);

  const result = await deps.reviewRepository.update({
    actorUserId: input.actorUserId,
    reviewId: input.reviewId,
    reflection,
    complete: input.complete,
    now: deps.now(),
  });
  switch (result.status) {
    case "ok":
      return toWeeklyReview(result.record);
    case "not_found":
      throw new WeeklyReviewNotFoundError();
    case "already_completed":
      throw new WeeklyReviewAlreadyCompletedError();
    default: {
      const exhaustive: never = result;
      return exhaustive;
    }
  }
}
