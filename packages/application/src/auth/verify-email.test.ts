import { describe, expect, it } from "vitest";
import { verifyEmail } from "./verify-email";
import { createFakeAuthRepository, createFakeTokenGenerator, createFixedClock } from "./test-fakes";

const NOW = new Date("2026-01-01T00:00:00Z");
const PAST = new Date("2025-12-31T00:00:00Z");
const FUTURE = new Date("2026-01-02T00:00:00Z");

function createTestContext(now = NOW) {
  const authRepository = createFakeAuthRepository();
  const tokenGenerator = createFakeTokenGenerator();
  return {
    authRepository,
    tokenGenerator,
    deps: { authRepository, tokenGenerator, now: createFixedClock(now) },
  };
}

describe("verifyEmail", () => {
  it("有効なtokenの検証に成功し、emailVerifiedAtが設定される(AUTH-003)", async () => {
    const { deps, authRepository, tokenGenerator } = createTestContext();
    const token = tokenGenerator.generate();
    await authRepository.createUserWithVerificationToken({
      emailNormalized: "user@example.com",
      passwordHash: "hash",
      verificationTokenHash: token.hash,
      verificationTokenExpiresAt: FUTURE,
    });

    const result = await verifyEmail(deps, { token: token.plaintext });

    expect(result).toEqual({ verified: true });
    const user = await authRepository.findUserByEmailNormalized("user@example.com");
    expect(user?.emailVerifiedAt).toEqual(NOW);
  });

  it("期限切れtokenの検証は失敗する(AUTH-003)", async () => {
    const { deps, authRepository, tokenGenerator } = createTestContext();
    const token = tokenGenerator.generate();
    await authRepository.createUserWithVerificationToken({
      emailNormalized: "user@example.com",
      passwordHash: "hash",
      verificationTokenHash: token.hash,
      verificationTokenExpiresAt: PAST,
    });

    const result = await verifyEmail(deps, { token: token.plaintext });

    expect(result).toEqual({ verified: false });
  });

  it("使用済みtokenでの再検証は失敗する(AUTH-INV-001)", async () => {
    const { deps, authRepository, tokenGenerator } = createTestContext();
    const token = tokenGenerator.generate();
    await authRepository.createUserWithVerificationToken({
      emailNormalized: "user@example.com",
      passwordHash: "hash",
      verificationTokenHash: token.hash,
      verificationTokenExpiresAt: FUTURE,
    });

    const first = await verifyEmail(deps, { token: token.plaintext });
    const second = await verifyEmail(deps, { token: token.plaintext });

    expect(first).toEqual({ verified: true });
    expect(second).toEqual({ verified: false });
  });

  it("存在しないtokenの検証は失敗する", async () => {
    const { deps } = createTestContext();

    const result = await verifyEmail(deps, { token: "unknown-token" });

    expect(result).toEqual({ verified: false });
  });
});
