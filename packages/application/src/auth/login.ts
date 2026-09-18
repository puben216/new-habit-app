import { normalizeEmail } from "@habit-app/domain";
import type { AuthRepositoryPort, PasswordHasherPort } from "./ports";

export interface LoginInput {
  readonly email: string;
  readonly password: string;
}

export type LoginResult = { readonly ok: true; readonly userId: string } | { readonly ok: false };

export interface LoginDeps {
  readonly authRepository: AuthRepositoryPort;
  readonly passwordHasher: PasswordHasherPort;
  /**
   * email 不存在時に AUTH-INV-002(処理時間差の排除)を満たすため verify() へ渡すダミーハッシュ。
   * 呼び出し元(Infrastructure の DI 構成)が PasswordHasherPort の実装と同一アルゴリズムで
   * 固定の placeholder password を事前に一度だけハッシュ化して注入する想定(login 実行のたびに
   * 計算し直さない)。これにより Application 層は hash 形式を知らずに済む。
   */
  readonly dummyPasswordHash: string;
}

/**
 * Credentials login(AUTH-005)。account 不存在/password 不一致/email 未確認/lockout は
 * すべて同一の失敗結果として扱う(AUTH-INV-002)。lockout 判定(AUTH-010)は Task 6 で
 * この use case に組み込む(Plan Task Breakdown)ため、ここでは扱わない。
 */
export async function login(deps: LoginDeps, input: LoginInput): Promise<LoginResult> {
  const emailNormalized = normalizeEmail(input.email);
  const user = await deps.authRepository.findUserByEmailNormalized(emailNormalized);

  if (user === null) {
    // account 不存在時も実在時と同等の処理時間になるよう、ダミーハッシュに対する検証を実行する。
    await deps.passwordHasher.verify(input.password, deps.dummyPasswordHash);
    return { ok: false };
  }

  const matched = await deps.passwordHasher.verify(input.password, user.passwordHash);
  if (!matched || user.emailVerifiedAt === null) {
    return { ok: false };
  }

  return { ok: true, userId: user.id };
}
