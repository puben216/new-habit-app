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
