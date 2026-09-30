export { InvalidPasswordError } from "@habit-app/domain";

export type {
  AuthRepositoryPort,
  AuthUserRecord,
  Clock,
  CreateUserResult,
  EmailSenderPort,
  LoginAttemptPort,
  LoginAttemptPurpose,
  PasswordHasherPort,
  RequestAcceptedResult,
  TokenConsumeResult,
  TokenGeneratorPort,
} from "./ports";

export {
  PASSWORD_RESET_TOKEN_TTL_MS,
  SESSION_TTL_MS,
  VERIFICATION_TOKEN_TTL_MS,
} from "./constants";

export { signUp } from "./sign-up";
export type { SignUpDeps, SignUpInput } from "./sign-up";

export { verifyEmail } from "./verify-email";
export type { VerifyEmailDeps, VerifyEmailInput, VerifyEmailResult } from "./verify-email";

export { resendVerification } from "./resend-verification";
export type { ResendVerificationDeps, ResendVerificationInput } from "./resend-verification";

export { login } from "./login";
export type { LoginDeps, LoginInput, LoginResult } from "./login";

export { requestPasswordReset } from "./request-password-reset";
export type { RequestPasswordResetDeps, RequestPasswordResetInput } from "./request-password-reset";

export { confirmPasswordReset } from "./confirm-password-reset";
export type {
  ConfirmPasswordResetDeps,
  ConfirmPasswordResetInput,
  ConfirmPasswordResetResult,
} from "./confirm-password-reset";
