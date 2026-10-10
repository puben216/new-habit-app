import type { HabitEntryStatus } from "@habit-app/domain";

import { createFakeHabitRepository, createSequentialIdGenerator } from "../habits/test-fakes";
import { createHabitUseCase } from "../habits/use-cases";
import { createFakeProfileRepository } from "../identity/test-fakes";
import { createFakeDailyCheckInRepository } from "../tracking/check-in-test-fakes";
import { createFakeHabitEntryRepository } from "../tracking/test-fakes";
import { createFakeWeeklyReviewRepository } from "../tracking/weekly-review-test-fakes";
import {
  createWeeklyReviewUseCase,
  updateWeeklyReviewUseCase,
} from "../tracking/weekly-review-use-cases";
import { POLICY } from "./fixtures";
import type { AiCoachPort } from "./ports";
import { createFakeAiJobQueue, createFakeAiJobRepository } from "./job-test-fakes";
import { WEEKLY_IMPROVEMENT_PROMPT_VERSION } from "./job-use-cases";
import type { GenerateSafeCoachingDeps } from "./generate-safe-coaching";

export const USER_A = "1";
export const USER_B = "2";

// 2026-01-14(水)12:00 JST。週(月曜始まり)は 2026-01-05(月)〜2026-01-11(日)。
export const WED_NOON_JST = "2026-01-14T03:00:00Z";
export const WEEK = "2026-01-05";

/** AI job の Unit Test 用の組み立て。時刻は `setNow` で進められる。 */
export function setupAiJobTest(coach: AiCoachPort, options: { publicationEnabled?: boolean } = {}) {
  let nowValue = new Date(WED_NOON_JST);
  const clock = () => nowValue;

  const habitRepository = createFakeHabitRepository();
  const idGenerator = createSequentialIdGenerator();
  const profileRepository = createFakeProfileRepository([USER_A, USER_B]);
  for (const userId of [USER_A, USER_B]) {
    profileRepository.seed({
      userId,
      displayName: null,
      timezone: "Asia/Tokyo",
      locale: "ja",
      weekStartsOn: 1,
      updatedAt: nowValue,
    });
  }
  const entryRepository = createFakeHabitEntryRepository([]);
  const checkInRepository = createFakeDailyCheckInRepository([USER_A, USER_B]);
  const reviewRepository = createFakeWeeklyReviewRepository([USER_A, USER_B]);
  const jobRepository = createFakeAiJobRepository([USER_A, USER_B], clock);
  const queue = createFakeAiJobQueue();

  const events: unknown[] = [];
  const sleeps: number[] = [];
  const generate: GenerateSafeCoachingDeps = {
    coach,
    audit: { record: async (event) => void events.push(event) },
    policy: POLICY,
    publicationEnabled: options.publicationEnabled ?? true,
    config: {
      promptVersion: WEEKLY_IMPROVEMENT_PROMPT_VERSION,
      attemptTimeoutMs: 50,
      baseBackoffMs: 100,
      maxBackoffMs: 1000,
    },
    sleep: async (ms) => void sleeps.push(ms),
    random: () => 0.5,
  };

  async function createHabit(actorUserId: string, name: string): Promise<string> {
    const record = await createHabitUseCase(
      { habitRepository, idGenerator, now: clock },
      {
        actorUserId,
        kind: "build",
        name,
        purpose: "健康維持",
        cue: "起床直後",
        minimumAction: "コップ1杯",
        schedule: {
          effectiveFrom: "2025-01-01",
          daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
          targetCount: 1,
        },
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

  const reviewDeps = () => ({
    reviewRepository,
    habitRepository,
    entryRepository,
    checkInRepository,
    profileRepository,
    now: clock,
  });

  /** 週次レビューを作成し、reflection を付けて確定する(`complete: false` なら draft のまま)。 */
  async function createReview(
    actorUserId: string,
    options: { reflection?: string | null; complete?: boolean; weekStart?: string } = {},
  ): Promise<string> {
    const { review } = await createWeeklyReviewUseCase(reviewDeps(), {
      actorUserId,
      weekStart: options.weekStart ?? WEEK,
    });
    if (options.reflection !== undefined || options.complete !== false) {
      await updateWeeklyReviewUseCase(
        { reviewRepository, now: clock },
        {
          actorUserId,
          reviewId: review.id,
          reflection: options.reflection === undefined ? "よく続いた" : options.reflection,
          complete: options.complete !== false,
        },
      );
    }
    return review.id;
  }

  const requestDeps = () => ({
    reviewRepository,
    habitRepository,
    jobRepository,
    queue,
    config: {
      promptVersion: WEEKLY_IMPROVEMENT_PROMPT_VERSION,
      provider: "fake",
      model: "fake-model-1",
    },
    now: clock,
  });

  const processDeps = () => ({
    reviewRepository,
    habitRepository,
    jobRepository,
    generate,
    now: clock,
  });

  return {
    clock,
    setNow(iso: string) {
      nowValue = new Date(iso);
    },
    habitRepository,
    reviewRepository,
    jobRepository,
    queue,
    events,
    sleeps,
    generate,
    createHabit,
    record,
    createReview,
    requestDeps,
    processDeps,
  };
}
