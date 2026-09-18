import { describe, expect, it } from "vitest";
import { requestPasswordReset } from "./request-password-reset";
import {
  createFakeAuthRepository,
  createFakeEmailSender,
  createFakeTokenGenerator,
  createFixedClock,
} from "./test-fakes";

function createTestContext() {
  const authRepository = createFakeAuthRepository();
  const emailSender = createFakeEmailSender();
  const tokenGenerator = createFakeTokenGenerator();
  return {
    authRepository,
    emailSender,
    deps: {
      authRepository,
      emailSender,
      tokenGenerator,
      now: createFixedClock(new Date("2026-01-01T00:00:00Z")),
    },
  };
}

describe("requestPasswordReset", () => {
  it("登録済みemailにresetを要求するとtokenが発行され通知される(AUTH-007)", async () => {
    const { deps, authRepository, emailSender } = createTestContext();
    await authRepository.createUserWithVerificationToken({
      emailNormalized: "user@example.com",
      passwordHash: "hash",
      verificationTokenHash: "unused",
      verificationTokenExpiresAt: new Date("2099-01-01T00:00:00Z"),
    });

    const result = await requestPasswordReset(deps, { email: "user@example.com" });

    expect(result).toEqual({ accepted: true });
    expect(emailSender.sentPasswordResetEmails).toHaveLength(1);
  });

  it("未登録emailでも同一のaccepted応答を返し、実際には通知しない(AUTH-INV-002)", async () => {
    const { deps, emailSender } = createTestContext();

    const result = await requestPasswordReset(deps, { email: "unknown@example.com" });

    expect(result).toEqual({ accepted: true });
    expect(emailSender.sentPasswordResetEmails).toHaveLength(0);
  });
});
