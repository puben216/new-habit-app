import { CLIENT_ERROR_CODES, isApiError } from "@/lib/api/api-error";

import type { CheckInIssue } from "./check-in";

/** 今日の記録画面の固定文言(TUI-INV-004: server の文字列は描画しない)。 */
export const RECORDED_MESSAGE = "記録しました。";
export const CHECK_IN_SAVED_MESSAGE = "保存しました。";
export const NETWORK_MESSAGE = "通信に失敗しました。時間をおいてもう一度お試しください。";
export const UNEXPECTED_MESSAGE =
  "処理を完了できませんでした。時間をおいてもう一度お試しください。";

export function checkInIssueMessage(issue: CheckInIssue): string {
  return issue === "empty"
    ? "気分・難しさ・メモのうち1つ以上入力してください。"
    : "メモは1000文字以内で入力してください。";
}

export function describeRecordError(error: unknown): string {
  if (!isApiError(error)) return UNEXPECTED_MESSAGE;
  if (error.code === CLIENT_ERROR_CODES.networkError) return NETWORK_MESSAGE;
  switch (error.code) {
    case "entry_date_out_of_range":
      return "この日付は記録できる範囲を過ぎています。画面を更新してください。";
    case "habit_not_scheduled":
      return "この日は予定のない習慣です。画面を更新してください。";
    case "invalid_habit_entry":
      return "この内容では記録できません。途中経過は目標回数より少ない回数を入力してください。";
    case "habit_archived":
      return "この習慣はアーカイブ済みのため記録できません。";
    case "habit_not_found":
      return "習慣が見つかりません。画面を更新してください。";
    default:
      return UNEXPECTED_MESSAGE;
  }
}

export function describeCheckInError(error: unknown): string {
  if (!isApiError(error)) return UNEXPECTED_MESSAGE;
  if (error.code === CLIENT_ERROR_CODES.networkError) return NETWORK_MESSAGE;
  switch (error.code) {
    case "check_in_date_out_of_range":
      return "この日付は保存できる範囲を過ぎています。画面を更新してください。";
    case "invalid_check_in":
      return "入力内容を確認してください。気分・難しさ・メモのうち1つ以上が必要です。";
    default:
      return UNEXPECTED_MESSAGE;
  }
}
