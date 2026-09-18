import { describe, expect, it } from "vitest";
import { resendVerification } from "./resend-verification";
import { verifyEmail } from "./verify-email";
import {
  createFakeAuthRepository,
  createFakeEmailSender,
  createFakeTokenGenerator,
  createFixedClock,
} from "./test-fakes";

const NOW = new Date("2026-01-01T00:00:00Z");
const FUTURE = new Date("2026-01-02T00:00:00Z");

function createTestContext() {
  const authRepository = createFakeAuthRepository();
  const emailSender = createFakeEmailSender();
  const tokenGenerator = createFakeTokenGenerator();
  const now = createFixedClock(NOW);
  return {
    authRepository,
    emailSender,
    tokenGenerator,
    deps: { authRepository, emailSender, tokenGenerator, now },
  };
}

describe("resendVerification", () => {
  it("未確認memberに再送すると新しいtokenが送られ旧tokenは失効する(AUTH-004)", async () => {
    const { deps, authRepository, tokenGenerator, emailSender } = createTestContext();
    const originalToken = tokenGenerator.generate();
    await authRepository.createUserWithVerificationToken({
      emailNormalized: "user@example.com",
      passwordHash: "hash",
      verificationTokenHash: originalToken.hash,
      verificationTokenExpiresAt: FUTURE,
    });

    const result = await resendVerification(deps, { email: "user@example.com" });

    expect(result).toEqual({ accepted: true });
    expect(emailSender.sentVerificationEmails).toHaveLength(1);

    const oldTokenResult = await verifyEmail(deps, { token: originalToken.plaintext });
    expect(oldTokenResult).toEqual({ verified: false });

    const newToken = emailSender.sentVerificationEmails[0]!.token;
    const newTokenResult = await verifyEmail(deps, { token: newToken });
    expect(newTokenResult).toEqual({ verified: true });
  });

  it("存在しないemailでも同一のaccepted応答を返す(AUTH-INV-002)", async () => {
    const { deps, emailSender } = createTestContext();

    const result = await resendVerification(deps, { email: "unknown@example.com" });

    expect(result).toEqual({ accepted: true });
    expect(emailSender.sentVerificationEmails).toHaveLength(0);
  });

  it("確認済みmemberへの再送は新しい通知を送らないが応答は同一(AUTH-INV-002)", async () => {
    const { deps, authRepository, tokenGenerator, emailSender } = createTestContext();
    const token = tokenGenerator.generate();
    await authRepository.createUserWithVerificationToken({
      emailNormalized: "user@example.com",
      passwordHash: "hash",
      verificationTokenHash: token.hash,
      verificationTokenExpiresAt: FUTURE,
    });
    await verifyEmail(deps, { token: token.plaintext });

    const result = await resendVerification(deps, { email: "user@example.com" });

    expect(result).toEqual({ accepted: true });
    expect(emailSender.sentVerificationEmails).toHaveLength(0);
  });
});
