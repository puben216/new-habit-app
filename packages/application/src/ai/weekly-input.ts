import { createHash } from "node:crypto";

import {
  WEEKLY_INPUT_MAX_HABITS,
  weeklyImprovementInputV1Schema,
  type WeeklyImprovementInputV1,
} from "@habit-app/contracts";
import { canonicalJson } from "@habit-app/domain";

import type { WeeklyReview } from "../tracking/weekly-review-use-cases";

/**
 * 週次レビューから `WeeklyImprovementInputV1` を組み立てる(docs/specs/ai-queue-pipeline.md AJOB-002)。
 * provider へ送る入力はここで 1 箇所に集約し、含めない項目(email、user ID、habit/review の外部 ID、
 * チェックインのメモ、習慣の purpose)を持ち込まない。
 */

/** fingerprint 計算時の `subjectId` の仮置き(fingerprint は `subjectId` を含めない)。 */
export const NIL_SUBJECT_ID = "00000000-0000-0000-0000-000000000000";

export interface ActiveHabitDetail {
  readonly cue: string;
  readonly minimumAction: string;
}

export type WeeklyInputResult =
  { readonly ok: true; readonly input: WeeklyImprovementInputV1 } | { readonly ok: false };

/**
 * `activeHabits` は habit の外部 ID をキーにした、active な習慣の `cue`/`minimumAction`。
 * アーカイブ済み(`activeHabits` にない)習慣は `cue`/`minimumAction` を `null` とする。
 * 習慣は summary の順に最大 `WEEKLY_INPUT_MAX_HABITS` 件。
 */
export function buildWeeklyImprovementInput(
  review: Pick<WeeklyReview, "summary" | "reflection">,
  activeHabits: ReadonlyMap<string, ActiveHabitDetail>,
  subjectId: string,
): WeeklyInputResult {
  const { summary } = review;
  const candidate = {
    subjectId,
    weekStart: summary.weekStart,
    habits: summary.habits.slice(0, WEEKLY_INPUT_MAX_HABITS).map((habit) => {
      const detail = activeHabits.get(habit.habitId);
      return {
        kind: habit.kind,
        name: habit.name,
        cue: detail?.cue ?? null,
        minimumAction: detail?.minimumAction ?? null,
        scheduledCount: habit.scheduled,
        successCount: habit.success,
        skippedCount: habit.skipped,
        missedCount: habit.missed,
      };
    }),
    checkIn: {
      days: summary.checkIn.days,
      averageMood: summary.checkIn.averageMood,
      averageDifficulty: summary.checkIn.averageDifficulty,
    },
    reflection: review.reflection,
  };

  const parsed = weeklyImprovementInputV1Schema.safeParse(candidate);
  return parsed.success ? { ok: true, input: parsed.data } : { ok: false };
}

/**
 * 入力の fingerprint(SHA-256 の hex)。`subjectId`(job ごとに変わる)を除いた canonical JSON から求めるため、
 * 同じレビュー・同じ入力なら同じ値になる(冪等キー)。
 */
export function fingerprintWeeklyInput(input: WeeklyImprovementInputV1): string {
  const withoutSubject = Object.fromEntries(
    Object.entries(input).filter(([key]) => key !== "subjectId"),
  );
  return createHash("sha256").update(canonicalJson(withoutSubject), "utf8").digest("hex");
}
