import { isValidCalendarDate } from "@habit-app/domain";

import { InvalidWeeklyReviewCursorError } from "./errors";

/**
 * 週次レビュー一覧の cursor(不透明な文字列)。直前ページ最後のレビューの `weekStart` だけを持つ。
 * user ID・内部 ID・時刻は含めない。改ざん・流用されても repository が actor 条件付きで
 * 解決するため、他ユーザーの情報には到達できない。
 */
interface CursorPayload {
  readonly v: 1;
  readonly w: string;
}

export function encodeWeeklyReviewCursor(weekStart: string): string {
  const payload: CursorPayload = { v: 1, w: weekStart };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/** 不正な cursor は InvalidWeeklyReviewCursorError。 */
export function decodeWeeklyReviewCursor(cursor: string): { readonly weekStart: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new InvalidWeeklyReviewCursorError();
  }
  if (typeof parsed !== "object" || parsed === null) throw new InvalidWeeklyReviewCursorError();
  const version: unknown = Reflect.get(parsed, "v");
  const weekStart: unknown = Reflect.get(parsed, "w");
  if (version !== 1 || typeof weekStart !== "string" || !isValidCalendarDate(weekStart)) {
    throw new InvalidWeeklyReviewCursorError();
  }
  return { weekStart };
}
