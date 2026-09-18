import { assertPasswordPolicy } from "@habit-app/domain";
import type { AuthRepositoryPort, Clock, PasswordHasherPort, TokenGeneratorPort } from "./ports";

export interface ConfirmPasswordResetInput {
  readonly token: string;
  readonly newPassword: string;
}

export type ConfirmPasswordResetResult = { readonly reset: true } | { readonly reset: false };

export interface ConfirmPasswordResetDeps {
  readonly authRepository: AuthRepositoryPort;
  readonly passwordHasher: PasswordHasherPort;
  readonly tokenGenerator: TokenGeneratorPort;
  readonly now: Clock;
}

/**
 * Password reset confirm(AUTH-008)。token の単回使用性(AUTH-INV-001)と、成功時の
 * 既存 session 全失効は AuthRepositoryPort.resetPasswordWithToken の実装が保証する。
 *
 * @throws {InvalidPasswordError} newPassword が policy(AUTH-002)を満たさない場合
 */
export async function confirmPasswordReset(
  deps: ConfirmPasswordResetDeps,
  input: ConfirmPasswordResetInput,
): Promise<ConfirmPasswordResetResult> {
  assertPasswordPolicy(input.newPassword);

  const tokenHash = deps.tokenGenerator.hash(input.token);
  const newPasswordHash = await deps.passwordHasher.hash(input.newPassword);

  const result = await deps.authRepository.resetPasswordWithToken({
    tokenHash,
    newPasswordHash,
    now: deps.now(),
  });

  return result === "consumed" ? { reset: true } : { reset: false };
}
