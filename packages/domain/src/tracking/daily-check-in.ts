import { InvalidDailyCheckInError } from "./errors";

/** 気分・難易度の尺度(DB の CHECK 制約 `daily_check_ins_mood_check`/`difficulty_check` と同じ値)。 */
export const DAILY_CHECK_IN_SCALE_MIN = 1;
export const DAILY_CHECK_IN_SCALE_MAX = 5;

export interface DailyCheckInInput {
  readonly mood?: number | null | undefined;
  readonly difficulty?: number | null | undefined;
  readonly note?: string | null | undefined;
}

/** 保存する内容。未設定の項目は null。少なくとも 1 項目は非 null。 */
export interface ResolvedDailyCheckIn {
  readonly mood: number | null;
  readonly difficulty: number | null;
  readonly note: string | null;
}

function resolveScale(
  field: "mood" | "difficulty",
  value: number | null | undefined,
): number | null {
  if (value === null || value === undefined) return null;
  if (
    !Number.isInteger(value) ||
    value < DAILY_CHECK_IN_SCALE_MIN ||
    value > DAILY_CHECK_IN_SCALE_MAX
  ) {
    throw new InvalidDailyCheckInError(
      field,
      `${field} は ${DAILY_CHECK_IN_SCALE_MIN}〜${DAILY_CHECK_IN_SCALE_MAX} の整数である必要があります。`,
    );
  }
  return value;
}

/**
 * デイリーチェックインの入力を検証・正規化する(docs/specs/daily-check-in.md DCI-002)。
 *
 * - mood/difficulty は 1〜5 の整数、または未設定。
 * - note は前後の空白を除去し、空になれば未設定。文字数上限・制御文字は契約 schema が検査する。
 * - 3 項目がすべて未設定の入力は拒否する(空のチェックインは保存しない)。
 */
export function resolveDailyCheckIn(input: DailyCheckInInput): ResolvedDailyCheckIn {
  const mood = resolveScale("mood", input.mood);
  const difficulty = resolveScale("difficulty", input.difficulty);
  const trimmed = input.note?.trim() ?? "";
  const note = trimmed.length > 0 ? trimmed : null;

  if (mood === null && difficulty === null && note === null) {
    throw new InvalidDailyCheckInError(
      "check_in",
      "mood、difficulty、note のいずれか 1 つ以上を指定してください。",
    );
  }
  return { mood, difficulty, note };
}
