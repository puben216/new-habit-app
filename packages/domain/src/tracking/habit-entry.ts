import type { HabitKind } from "../habits/habit-kind";
import { InvalidHabitEntryError } from "./errors";

export const HABIT_ENTRY_STATUSES = ["success", "missed", "skipped"] as const;
export type HabitEntryStatus = (typeof HABIT_ENTRY_STATUSES)[number];

/** 1 日の実施回数の上限(DB の `habit_entries_quantity_check` と同じ値)。 */
export const HABIT_ENTRY_MAX_QUANTITY = 1000;

export interface HabitEntryInput {
  readonly status: HabitEntryStatus;
  readonly quantity?: number | null | undefined;
}

/** 保存する記録の内容。`quantity` が null の場合は回数を持たない。 */
export interface ResolvedHabitEntry {
  readonly status: HabitEntryStatus;
  readonly quantity: number | null;
}

function assertValidQuantity(quantity: number): void {
  if (!Number.isInteger(quantity) || quantity < 0 || quantity > HABIT_ENTRY_MAX_QUANTITY) {
    throw new InvalidHabitEntryError(
      "quantity",
      `quantity は 0〜${HABIT_ENTRY_MAX_QUANTITY} の整数である必要があります。`,
    );
  }
}

/**
 * 記録の入力を、習慣の kind とその日の目標回数(targetCount)に対して検証・正規化する
 * (docs/specs/habit-entry.md HENT-003)。
 *
 * - build の success は `quantity >= targetCount`(`isTargetMet` と同値)。省略時は targetCount。
 * - build の missed は `quantity < targetCount`(途中経過の記録)。省略時は 0。
 * - skipped と reduce は quantity を持たない。reduce は status のみで成否を表す。
 */
export function resolveHabitEntry(
  kind: HabitKind,
  targetCount: number,
  input: HabitEntryInput,
): ResolvedHabitEntry {
  const quantity = input.quantity ?? null;

  if (kind === "reduce" || input.status === "skipped") {
    if (quantity !== null) {
      throw new InvalidHabitEntryError(
        "quantity",
        kind === "reduce"
          ? "reduce の記録では quantity を指定できません。"
          : "skipped の記録では quantity を指定できません。",
      );
    }
    return { status: input.status, quantity: null };
  }

  if (quantity !== null) assertValidQuantity(quantity);

  switch (input.status) {
    case "success": {
      const resolved = quantity ?? targetCount;
      if (resolved < targetCount) {
        throw new InvalidHabitEntryError(
          "quantity",
          `success の quantity は目標回数(${targetCount})以上である必要があります。`,
        );
      }
      return { status: "success", quantity: resolved };
    }
    case "missed": {
      const resolved = quantity ?? 0;
      if (resolved >= targetCount) {
        throw new InvalidHabitEntryError(
          "quantity",
          `missed の quantity は目標回数(${targetCount})未満である必要があります。`,
        );
      }
      return { status: "missed", quantity: resolved };
    }
    default: {
      const exhaustive: never = input.status;
      return exhaustive;
    }
  }
}
