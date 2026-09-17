/**
 * auth モジュールの Domain 不変条件違反を表すエラー階層。
 *
 * Application 層(T-101)はこれらを catch し、HTTP/ユースケース固有のエラー型へ
 * 変換する想定。Domain 自身は HTTP ステータス等を持たない。
 */
export class AuthDomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** password が policy(docs/specs/auth-adapter.md AUTH-002)を満たさない場合。 */
export class InvalidPasswordError extends AuthDomainError {}
