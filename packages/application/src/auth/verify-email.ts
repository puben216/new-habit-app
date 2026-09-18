import type { AuthRepositoryPort, Clock, TokenGeneratorPort } from "./ports";

export interface VerifyEmailInput {
  readonly token: string;
}

export type VerifyEmailResult = { readonly verified: true } | { readonly verified: false };

export interface VerifyEmailDeps {
  readonly authRepository: AuthRepositoryPort;
  readonly tokenGenerator: TokenGeneratorPort;
  readonly now: Clock;
}

/**
 * Email verification(AUTH-003)。期限切れ/使用済み/不正な token はすべて同一の
 * 失敗結果として扱う(理由を外部に漏らさない)。単回使用性(AUTH-INV-001)は
 * AuthRepositoryPort.consumeVerificationToken の実装(Infrastructure)が保証する。
 */
export async function verifyEmail(
  deps: VerifyEmailDeps,
  input: VerifyEmailInput,
): Promise<VerifyEmailResult> {
  const tokenHash = deps.tokenGenerator.hash(input.token);
  const result = await deps.authRepository.consumeVerificationToken({
    tokenHash,
    now: deps.now(),
  });

  return result === "consumed" ? { verified: true } : { verified: false };
}
