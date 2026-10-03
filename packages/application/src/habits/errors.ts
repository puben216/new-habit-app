/**
 * habits use case の Application error。Presentation が HTTP status へ変換する。
 * Domain の不変条件違反(HabitDomainError 階層)はここでラップせずそのまま伝播させる。
 * メッセージに自由記述やユーザー識別子を含めない。
 */
export class HabitApplicationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** 習慣が存在しない、または actor の所有ではない(両者を区別しない。HAPI-INV-001)。 */
export class HabitNotFoundError extends HabitApplicationError {
  constructor() {
    super("habit not found");
  }
}

/** 送信された version が現在の version と一致しない(HAPI-INV-002)。 */
export class HabitVersionConflictError extends HabitApplicationError {
  constructor() {
    super("habit version conflict");
  }
}

/** cursor が不正(形式、status 不一致、actor の習慣を指さない)。 */
export class InvalidCursorError extends HabitApplicationError {
  constructor() {
    super("invalid cursor");
  }
}
