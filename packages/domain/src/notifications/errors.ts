/** notifications module の Domain 不変条件違反を表すエラー階層(docs/specs/notification-preferences.md NPF-003)。 */
export class NotificationDomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export type NotificationPreferenceField = "localTime" | "timezone" | "quietHours";

/** 通知設定の値が不整合な場合。メッセージに入力値を含めない。 */
export class InvalidNotificationPreferenceError extends NotificationDomainError {
  /** 問題のある入力項目。Presentation が fieldErrors の項目名に使う。 */
  readonly field: NotificationPreferenceField;

  constructor(field: NotificationPreferenceField, message: string) {
    super(message);
    this.field = field;
  }
}

/** 有効な設定で、送信時刻が quiet hours に含まれる(その時刻の通知が常に送られない)場合。 */
export class ReminderTimeInQuietHoursError extends NotificationDomainError {
  constructor() {
    super("reminder time falls within quiet hours");
  }
}
