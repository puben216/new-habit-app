import { normalizeEmail } from "@habit-app/domain";
import { VERIFICATION_TOKEN_TTL_MS } from "./constants";
import type {
  AuthRepositoryPort,
  Clock,
  EmailSenderPort,
  RequestAcceptedResult,
  TokenGeneratorPort,
} from "./ports";

export interface ResendVerificationInput {
  readonly email: string;
}

export interface ResendVerificationDeps {
  readonly authRepository: AuthRepositoryPort;
  readonly tokenGenerator: TokenGeneratorPort;
  readonly emailSender: EmailSenderPort;
  readonly now: Clock;
}

/**
 * Verification 再送(AUTH-004)。email 不存在・確認済み・未確認のいずれでも外部応答を
 * 統一する(AUTH-INV-002)。実際に再送するのは email 未確認の既存 account のみで、
 * その際は直前の未使用 token を無効化してから新しい token を発行する。
 */
export async function resendVerification(
  deps: ResendVerificationDeps,
  input: ResendVerificationInput,
): Promise<RequestAcceptedResult> {
  const emailNormalized = normalizeEmail(input.email);
  const user = await deps.authRepository.findUserByEmailNormalized(emailNormalized);

  if (user !== null && user.emailVerifiedAt === null) {
    const verificationToken = deps.tokenGenerator.generate();
    const expiresAt = new Date(deps.now().getTime() + VERIFICATION_TOKEN_TTL_MS);

    await deps.authRepository.replaceVerificationToken({
      userId: user.id,
      tokenHash: verificationToken.hash,
      expiresAt,
    });
    await deps.emailSender.sendVerificationEmail(emailNormalized, verificationToken.plaintext);
  }

  return { accepted: true };
}
