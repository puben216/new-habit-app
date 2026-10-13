import type { LoginAttemptPort, PasswordHasherPort } from "../auth";
import { ReauthenticationFailedError, TooManyAttemptsError } from "./errors";
import type { ReauthRecord } from "./ports";

/**
 * 再認証(パスワードの再入力)。アカウント削除とデータエクスポートが共有する
 * (docs/specs/account-deletion.md ACD-001、docs/specs/data-export.md EXP-INV-003)。
 *
 * 失敗は `login_attempts` の `reauth` として数え、直近 15 分に 5 回で制限する(通常のログインとは独立)。
 * 制限中は、パスワードが正しくても検証しない(総当たりの手がかりを与えない)。パスワードは検証にのみ使う。
 */
export interface ReauthenticationDeps {
  readonly passwordHasher: PasswordHasherPort;
  readonly attempts: LoginAttemptPort;
}

/**
 * @throws {TooManyAttemptsError} 再認証の失敗が上限に達している
 * @throws {ReauthenticationFailedError} パスワードが一致しない
 */
export async function verifyReauthentication(
  deps: ReauthenticationDeps,
  account: ReauthRecord,
  password: string,
): Promise<void> {
  if (await deps.attempts.isBlocked("reauth", account.emailNormalized)) {
    throw new TooManyAttemptsError();
  }
  const matched = await deps.passwordHasher.verify(password, account.passwordHash);
  await deps.attempts.record("reauth", account.emailNormalized, matched);
  if (!matched) throw new ReauthenticationFailedError();
}
