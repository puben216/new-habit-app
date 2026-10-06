/**
 * notifications use case の Application error。Presentation が HTTP status へ変換する。
 * メッセージにユーザー識別子や設定値を含めない。
 */
export class NotificationApplicationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** actor の user が存在しない(削除済み等)。 */
export class NotificationUserNotFoundError extends NotificationApplicationError {
  constructor() {
    super("user not found");
  }
}
