import { HabitDomainError } from "../habits/errors";

/** 記録の status/quantity が、習慣の kind と目標回数に対して不整合な場合(docs/specs/habit-entry.md HENT-003)。 */
export class InvalidHabitEntryError extends HabitDomainError {
  /** 問題のある入力項目。Presentation が fieldErrors の項目名に使う。 */
  readonly field: "status" | "quantity";

  constructor(field: "status" | "quantity", message: string) {
    super(message);
    this.field = field;
  }
}

/** デイリーチェックインの内容が不整合な場合(docs/specs/daily-check-in.md DCI-002)。 */
export class InvalidDailyCheckInError extends HabitDomainError {
  /** 問題のある入力項目。`check_in` は項目横断のルール(全項目が未設定)。 */
  readonly field: "mood" | "difficulty" | "note" | "check_in";

  constructor(field: "mood" | "difficulty" | "note" | "check_in", message: string) {
    super(message);
    this.field = field;
  }
}

/** 週次レビューの振り返りが不正な場合(docs/specs/weekly-review.md WREV-005)。 */
export class InvalidWeeklyReviewError extends HabitDomainError {
  /** 問題のある入力項目。`update` は項目横断のルール(更新内容が何もない)。 */
  readonly field: "reflection" | "update";

  constructor(field: "reflection" | "update", message: string) {
    super(message);
    this.field = field;
  }
}
