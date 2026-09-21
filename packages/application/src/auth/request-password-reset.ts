import { normalizeEmail } from "@habit-app/domain";
import { PASSWORD_RESET_TOKEN_TTL_MS } from "./constants";
import type {
  AuthRepositoryPort,
  Clock,
  EmailSenderPort,
  RequestAcceptedResult,
  TokenGeneratorPort,
} from "./ports";

export interface RequestPasswordResetInput {
  readonly email: string;
}

export interface RequestPasswordResetDeps {
  readonly authRepository: AuthRepositoryPort;
  readonly tokenGenerator: TokenGeneratorPort;
  readonly emailSender: EmailSenderPort;
  readonly now: Clock;
}

/**
 * Password reset request(AUTH-007)。email の登録有無によらず外部応答を統一する(AUTH-INV-002)。
 * 登録済み account が存在する場合のみ実際に reset token を発行・通知する。
 */
export async function requestPasswordReset(
  deps: RequestPasswordResetDeps,
  input: RequestPasswordResetInput,
): Promise<RequestAcceptedResult> {
  const emailNormalized = normalizeEmail(input.email);
  const user = await deps.authRepository.findUserByEmailNormalized(emailNormalized);

  if (user !== null) {
    const resetToken = deps.tokenGenerator.generate();
    const expiresAt = new Date(deps.now().getTime() + PASSWORD_RESET_TOKEN_TTL_MS);

    await deps.authRepository.createPasswordResetToken({
      userId: user.id,
      tokenHash: resetToken.hash,
      expiresAt,
    });
    await deps.emailSender.sendPasswordResetEmail(emailNormalized, resetToken.plaintext);
  }

  return { accepted: true };
}
