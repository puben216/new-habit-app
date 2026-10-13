/**
 * アカウント削除 use case の Application error。Presentation が HTTP status へ変換する。
 * メッセージにユーザー識別子・パスワード・メールを含めない。
 */
export class AccountApplicationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** 再認証(パスワード)に失敗した。誤りの種類は区別しない。 */
export class ReauthenticationFailedError extends AccountApplicationError {
  constructor() {
    super("reauthentication failed");
  }
}

/** 再認証の失敗が続いたため、検証せずに拒否した。 */
export class TooManyAttemptsError extends AccountApplicationError {
  constructor() {
    super("too many attempts");
  }
}

/** 既に削除予約中。 */
export class DeletionAlreadyRequestedError extends AccountApplicationError {
  constructor() {
    super("deletion already requested");
  }
}

/** active ではない(停止中など)ため、削除を要求できない。 */
export class AccountNotActiveError extends AccountApplicationError {
  constructor() {
    super("account is not active");
  }
}

/** 削除予約中ではない(取り消す対象がない)。 */
export class DeletionNotRequestedError extends AccountApplicationError {
  constructor() {
    super("deletion not requested");
  }
}

/** 猶予期間が終わっているため、取り消せない。 */
export class GracePeriodExpiredError extends AccountApplicationError {
  constructor() {
    super("grace period expired");
  }
}

/** actor の user が存在しない(削除済み等)。 */
export class AccountNotFoundError extends AccountApplicationError {
  constructor() {
    super("account not found");
  }
}
