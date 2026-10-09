import type { CreateHabitRequest, HabitResponse, UpdateHabitRequest } from "@habit-app/contracts";

/**
 * 習慣フォームの値・検証・request body の組み立て(docs/specs/habit-screens.md HUI-002/003)。
 * 検証は入力の目安(必須・上限・範囲)のみで、業務ルール(reduce の回数固定、遡及編集等)は server が判定する。
 */
export type HabitKind = "build" | "reduce";

export const NAME_MAX = 100;
export const TEXT_MAX = 500;
export const TARGET_COUNT_MAX = 100;

export interface HabitFormValues {
  readonly kind: HabitKind;
  readonly name: string;
  readonly purpose: string;
  readonly cue: string;
  readonly minimumAction: string;
  readonly replacementAction: string;
  readonly effectiveFrom: string;
  readonly daysOfWeek: readonly number[];
  readonly targetCount: string;
}

export type HabitFormField =
  | "name"
  | "purpose"
  | "cue"
  | "minimumAction"
  | "replacementAction"
  | "effectiveFrom"
  | "daysOfWeek"
  | "targetCount";

export type FormIssue = "required" | "too_long" | "invalid";
export type HabitFormIssues = Partial<Record<HabitFormField, FormIssue>>;

function textIssue(value: string, max: number, required: boolean): FormIssue | null {
  const trimmed = value.trim();
  if (required && trimmed.length === 0) return "required";
  if (trimmed.length > max) return "too_long";
  return null;
}

export function validateHabitForm(values: HabitFormValues): HabitFormIssues {
  const issues: { -readonly [K in HabitFormField]?: FormIssue } = {};
  const set = (field: HabitFormField, issue: FormIssue | null) => {
    if (issue !== null) issues[field] = issue;
  };

  set("name", textIssue(values.name, NAME_MAX, true));
  set("purpose", textIssue(values.purpose, TEXT_MAX, true));
  set("cue", textIssue(values.cue, TEXT_MAX, true));
  set("minimumAction", textIssue(values.minimumAction, TEXT_MAX, true));
  if (values.kind === "reduce") {
    set("replacementAction", textIssue(values.replacementAction, TEXT_MAX, false));
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(values.effectiveFrom)) issues.effectiveFrom = "required";
  if (values.daysOfWeek.length === 0) issues.daysOfWeek = "required";
  if (values.kind === "build") {
    const count = Number(values.targetCount);
    if (
      values.targetCount.trim() === "" ||
      !Number.isInteger(count) ||
      count < 1 ||
      count > TARGET_COUNT_MAX
    ) {
      issues.targetCount = "invalid";
    }
  }
  return issues;
}

function sortedDays(days: readonly number[]): number[] {
  return [...new Set(days)].sort((a, b) => a - b);
}

function targetCountFor(values: HabitFormValues): number {
  return values.kind === "reduce" ? 1 : Number(values.targetCount);
}

export function toCreateBody(values: HabitFormValues): CreateHabitRequest {
  const replacement = values.replacementAction.trim();
  return {
    kind: values.kind,
    name: values.name.trim(),
    purpose: values.purpose.trim(),
    cue: values.cue.trim(),
    minimumAction: values.minimumAction.trim(),
    ...(values.kind === "reduce" && replacement !== "" ? { replacementAction: replacement } : {}),
    schedule: {
      effectiveFrom: values.effectiveFrom,
      daysOfWeek: sortedDays(values.daysOfWeek),
      targetCount: targetCountFor(values),
    },
  };
}

/** 現在有効なスケジュール(`effectiveTo` が null の版。なければ最後の版)。 */
export function currentSchedule(
  habit: HabitResponse,
): HabitResponse["scheduleVersions"][number] | undefined {
  return (
    habit.scheduleVersions.find((version) => version.effectiveTo === null) ??
    habit.scheduleVersions[habit.scheduleVersions.length - 1]
  );
}

/** 習慣から編集フォームの初期値を作る。適用開始日は `today`。 */
export function valuesFromHabit(habit: HabitResponse, today: string): HabitFormValues {
  const schedule = currentSchedule(habit);
  return {
    kind: habit.kind,
    name: habit.name,
    purpose: habit.purpose,
    cue: habit.cue,
    minimumAction: habit.minimumAction,
    replacementAction: habit.replacementAction ?? "",
    effectiveFrom: today,
    daysOfWeek: sortedDays(schedule?.daysOfWeek ?? []),
    targetCount: String(schedule?.targetCount ?? 1),
  };
}

/**
 * 変更した項目だけの更新 body。変更がなければ `null`(request を送らない)。
 * `version` は取得時点の値を必ず付ける(HUI-INV-003)。
 */
export function toUpdateBody(
  habit: HabitResponse,
  values: HabitFormValues,
): UpdateHabitRequest | null {
  const changes: { -readonly [K in keyof UpdateHabitRequest]?: UpdateHabitRequest[K] } = {};

  const name = values.name.trim();
  if (name !== habit.name) changes.name = name;
  const purpose = values.purpose.trim();
  if (purpose !== habit.purpose) changes.purpose = purpose;
  const cue = values.cue.trim();
  if (cue !== habit.cue) changes.cue = cue;
  const minimumAction = values.minimumAction.trim();
  if (minimumAction !== habit.minimumAction) changes.minimumAction = minimumAction;

  if (habit.kind === "reduce") {
    const replacement = values.replacementAction.trim();
    if (replacement !== (habit.replacementAction ?? "")) {
      changes.replacementAction = replacement === "" ? null : replacement;
    }
  }

  const current = currentSchedule(habit);
  const days = sortedDays(values.daysOfWeek);
  const count = targetCountFor(values);
  const scheduleChanged =
    current === undefined ||
    current.targetCount !== count ||
    sortedDays(current.daysOfWeek).join(",") !== days.join(",");
  if (scheduleChanged) {
    changes.schedule = {
      effectiveFrom: values.effectiveFrom,
      daysOfWeek: days,
      targetCount: count,
    };
  }

  if (Object.keys(changes).length === 0) return null;
  return { version: habit.version, ...changes };
}
