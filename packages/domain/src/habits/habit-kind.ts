import { InvalidHabitKindError } from "./errors";

/**
 * 習慣の種類。
 *
 * - build: 身につけたい習慣。1 日の目標回数(targetCount)を複数に設定でき、
 *   その日の実施回数(quantity)が targetCount 以上であれば成功。
 * - reduce: 減らしたい習慣。MVP では 1 日 1 回の判定に固定する(targetCount は常に 1)。
 *
 * 種類は作成後変更不可(docs/01-product-requirements.md の業務ルール)。
 * この不変条件は habit.ts 側で「kind を変更する更新APIを提供しない」ことと
 * 「Habit オブジェクトを freeze して実行時の再代入を防ぐ」ことの両方で担保する。
 */
export const HABIT_KINDS = ["build", "reduce"] as const;

export type HabitKind = (typeof HABIT_KINDS)[number];

export function isHabitKind(value: unknown): value is HabitKind {
  return typeof value === "string" && (HABIT_KINDS as readonly string[]).includes(value);
}

export function assertHabitKind(value: unknown): asserts value is HabitKind {
  if (!isHabitKind(value)) {
    throw new InvalidHabitKindError(
      `HabitKind は ${HABIT_KINDS.join(" | ")} のいずれかである必要があります: ${String(value)}`,
    );
  }
}
