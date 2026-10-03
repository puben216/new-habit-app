/**
 * identity モジュールの Domain 不変条件違反を表すエラー階層。
 *
 * Application 層はこれらを catch し、HTTP/ユースケース固有のエラー型へ変換する想定。
 * Domain 自身は HTTP ステータス等を持たない。
 */
export class IdentityDomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export type ProfileField = "displayName" | "timezone" | "locale" | "weekStartsOn";

export interface ProfileViolation {
  /** `_root` は特定の項目に紐づかない違反(空の更新)。 */
  readonly field: ProfileField | "_root";
  /** 利用者向けの固定メッセージ。入力値そのもの(自由記述)は含めない。 */
  readonly message: string;
}

/** プロフィールの入力値が不変条件(docs/specs/user-profile.md PROF-003〜005)を満たさない場合。 */
export class InvalidProfileError extends IdentityDomainError {
  readonly violations: readonly ProfileViolation[];

  constructor(violations: readonly ProfileViolation[]) {
    super("プロフィールの入力値が不正です");
    this.violations = violations;
  }
}
