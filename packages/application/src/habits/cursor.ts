import { InvalidCursorError } from "./errors";
import type { HabitListStatus } from "./ports";

/**
 * 一覧の cursor(不透明な文字列)。
 * 直前ページ最後の習慣の外部 ID と、発行時の status だけを持つ。user ID・内部 ID・時刻は含めない。
 * 改ざん・流用されても repository が actor 条件付きで解決するため、他ユーザーの情報には到達できない。
 */
interface CursorPayload {
  readonly v: 1;
  readonly h: string;
  readonly s: HabitListStatus;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeHabitCursor(input: {
  readonly habitId: string;
  readonly status: HabitListStatus;
}): string {
  const payload: CursorPayload = { v: 1, h: input.habitId, s: input.status };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/** 不正な cursor は InvalidCursorError。`expectedStatus` と異なる status の cursor も不正。 */
export function decodeHabitCursor(
  cursor: string,
  expectedStatus: HabitListStatus,
): { readonly habitId: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new InvalidCursorError();
  }
  if (typeof parsed !== "object" || parsed === null) throw new InvalidCursorError();
  const version: unknown = Reflect.get(parsed, "v");
  const habitId: unknown = Reflect.get(parsed, "h");
  const status: unknown = Reflect.get(parsed, "s");
  if (
    version !== 1 ||
    typeof habitId !== "string" ||
    !UUID_PATTERN.test(habitId) ||
    status !== expectedStatus
  ) {
    throw new InvalidCursorError();
  }
  return { habitId };
}
