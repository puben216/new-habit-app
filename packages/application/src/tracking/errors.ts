import type { WeekNotReviewableReason } from "@habit-app/domain";

/**
 * tracking use case の Application error。Presentation が HTTP status へ変換する。
 * メッセージに自由記述やユーザー識別子を含めない。
 * 習慣の不存在は habits の `HabitNotFoundError`、アーカイブ済みは Domain の `HabitArchivedError` を使う。
 */
export class TrackingApplicationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** 対象日が「今日から過去 N 日まで」の範囲外(未来日を含む)。 */
export class EntryDateOutOfRangeError extends TrackingApplicationError {
  constructor() {
    super("entry date out of range");
  }
}

/** 対象日にその習慣の予定機会がない(曜日が対象外、または有効期間外)。 */
export class HabitNotScheduledError extends TrackingApplicationError {
  constructor() {
    super("habit not scheduled on the date");
  }
}

/** チェックインの対象日が「今日から過去 N 日まで」の範囲外(未来日を含む)。 */
export class CheckInDateOutOfRangeError extends TrackingApplicationError {
  constructor() {
    super("check-in date out of range");
  }
}

/** その日のチェックインが存在しない(自分の分のみが対象)。 */
export class DailyCheckInNotFoundError extends TrackingApplicationError {
  constructor() {
    super("daily check-in not found");
  }
}

/** actor の user が存在しない(削除済み等)。 */
export class UserNotFoundError extends TrackingApplicationError {
  constructor() {
    super("user not found");
  }
}

/** 週次レビューの対象週が作成できない(WREV-002)。理由は Presentation が `fieldErrors.weekStart` の文言に使う。 */
export class ReviewWeekNotAllowedError extends TrackingApplicationError {
  readonly reason: WeekNotReviewableReason;

  constructor(reason: WeekNotReviewableReason) {
    super(`review week not allowed: ${reason}`);
    this.reason = reason;
  }
}

/** 週次レビューが存在しない(他ユーザーのレビューを含む。存在を区別しない)。 */
export class WeeklyReviewNotFoundError extends TrackingApplicationError {
  constructor() {
    super("weekly review not found");
  }
}

/** 確定済みの週次レビューは変更できない(WREV-005)。 */
export class WeeklyReviewAlreadyCompletedError extends TrackingApplicationError {
  constructor() {
    super("weekly review already completed");
  }
}

/** 週次レビュー一覧の cursor が不正。 */
export class InvalidWeeklyReviewCursorError extends TrackingApplicationError {
  constructor() {
    super("invalid weekly review cursor");
  }
}

/** 保存済みのスナップショットが schema に合わない(データ破損)。内容を含めない。 */
export class CorruptedWeeklyReviewError extends TrackingApplicationError {
  constructor() {
    super("persisted weekly review violates invariants");
  }
}
