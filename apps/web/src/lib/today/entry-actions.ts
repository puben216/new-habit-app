import type { TodayScheduleResponse, UpsertHabitEntryRequest } from "@habit-app/contracts";

/**
 * 記録操作と request body・表示の対応(docs/specs/today-screens.md TUI-003、TUI-INV-001)。
 * 成否の判定(回数と status の整合、reduce の意味)は server が行う。ここは操作の種類から `status` を決めるだけ。
 */
export type HabitKind = "build" | "reduce";
export type RecordAction = "done" | "missed" | "skipped" | "progress";
export type Entry = NonNullable<TodayScheduleResponse["items"][number]["entry"]>;

export function entryBodyFor(
  kind: HabitKind,
  action: RecordAction,
  quantity?: number,
): UpsertHabitEntryRequest {
  switch (action) {
    case "done":
      return { status: "success" };
    case "missed":
      return { status: "missed" };
    case "skipped":
      return { status: "skipped" };
    case "progress":
      // 途中経過は build の回数付き。reduce は quantity を持たない。
      return kind === "build" && quantity !== undefined
        ? { status: "missed", quantity }
        : { status: "missed" };
    default: {
      const unreachable: never = action;
      return unreachable;
    }
  }
}

/** 現在の記録に対応する操作(`aria-pressed` 用)。回数付きの missed は途中経過。 */
export function actionForEntry(entry: Entry | null): RecordAction | null {
  if (entry === null) return null;
  if (entry.status === "success") return "done";
  if (entry.status === "skipped") return "skipped";
  return entry.quantity !== null && entry.quantity > 0 ? "progress" : "missed";
}

export function entryLabel(kind: HabitKind, entry: Entry | null, targetCount: number): string {
  if (entry === null) return "未記録";
  if (entry.status === "skipped") return "スキップ";
  if (kind === "reduce") return entry.status === "success" ? "回避できた" : "してしまった";
  if (entry.status === "success") {
    return targetCount > 1 ? `できた(${entry.quantity ?? targetCount}/${targetCount}回)` : "できた";
  }
  return entry.quantity !== null && entry.quantity > 0
    ? `途中経過(${entry.quantity}/${targetCount}回)`
    : "できなかった";
}

export const ACTION_LABELS: Record<HabitKind, Record<Exclude<RecordAction, "progress">, string>> = {
  build: { done: "できた", missed: "できなかった", skipped: "スキップ" },
  reduce: { done: "回避できた", missed: "してしまった", skipped: "スキップ" },
};
