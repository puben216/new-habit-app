import type { UpsertDailyCheckInRequest } from "@habit-app/contracts";

/** デイリーチェックインの入力値・検証・body(docs/specs/today-screens.md TUI-004)。 */
export const NOTE_MAX = 1000;

export interface CheckInValues {
  readonly mood: number | null;
  readonly difficulty: number | null;
  readonly note: string;
}

export type CheckInIssue = "empty" | "note_too_long";

export function validateCheckIn(values: CheckInValues): CheckInIssue | null {
  if (values.note.length > NOTE_MAX) return "note_too_long";
  if (values.mood === null && values.difficulty === null && values.note.trim() === "") {
    return "empty";
  }
  return null;
}

/** PUT は全項目の置換。未設定は `null` で送る。 */
export function toCheckInBody(values: CheckInValues): UpsertDailyCheckInRequest {
  return {
    mood: values.mood,
    difficulty: values.difficulty,
    note: values.note.trim() === "" ? null : values.note,
  };
}
