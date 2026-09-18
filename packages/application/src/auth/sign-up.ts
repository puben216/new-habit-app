import { assertPasswordPolicy, normalizeEmail } from "@habit-app/domain";
import { VERIFICATION_TOKEN_TTL_MS } from "./constants";
import type {
  AuthRepositoryPort,
  Clock,
  EmailSenderPort,
  PasswordHasherPort,
  RequestAcceptedResult,
  TokenGeneratorPort,
} from "./ports";

export interface SignUpInput {
  readonly email: string;
  readonly password: string;
}

export interface SignUpDeps {
  readonly authRepository: AuthRepositoryPort;
  readonly passwordHasher: PasswordHasherPort;
  readonly tokenGenerator: TokenGeneratorPort;
  readonly emailSender: EmailSenderPort;
  readonly now: Clock;
}

/**
 * Credentials signup(AUTH-001)。email の登録有無によらず外部応答を統一する(AUTH-INV-002)ため、
 * password hash・token 生成は常に実行し、実際の account 作成有無だけで通知送信を分岐する。
 *
 * @throws {InvalidPasswordError} password が policy(AUTH-002)を満たさない場合
 */
export async function signUp(deps: SignUpDeps, input: SignUpInput): Promise<RequestAcceptedResult> {
  assertPasswordPolicy(input.password);

  const emailNormalized = normalizeEmail(input.email);
  const passwordHash = await deps.passwordHasher.hash(input.password);
  const verificationToken = deps.tokenGenerator.generate();
  const verificationTokenExpiresAt = new Date(deps.now().getTime() + VERIFICATION_TOKEN_TTL_MS);

  const result = await deps.authRepository.createUserWithVerificationToken({
    emailNormalized,
    passwordHash,
    verificationTokenHash: verificationToken.hash,
    verificationTokenExpiresAt,
  });

  if (result === "created") {
    await deps.emailSender.sendVerificationEmail(emailNormalized, verificationToken.plaintext);
  }

  return { accepted: true };
}
