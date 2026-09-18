import { InvalidPasswordError } from "@habit-app/domain";
import { describe, expect, it } from "vitest";
import { confirmPasswordReset } from "./confirm-password-reset";
import {
  createFakeAuthRepository,
  createFakePasswordHasher,
  createFakeTokenGenerator,
  createFixedClock,
} from "./test-fakes";

const NOW = new Date("2026-01-01T00:00:00Z");
const PAST = new Date("2025-12-31T00:00:00Z");
const FUTURE = new Date("2026-01-02T00:00:00Z");

function createTestContext(now = NOW) {
  const authRepository = createFakeAuthRepository();
  const passwordHasher = createFakePasswordHasher();
  const tokenGenerator = createFakeTokenGenerator();
  return {
    authRepository,
    passwordHasher,
    tokenGenerator,
    deps: { authRepository, passwordHasher, tokenGenerator, now: createFixedClock(now) },
  };
}

describe("confirmPasswordReset", () => {
  it("有効なtokenと新しいpasswordでpasswordが更新される(AUTH-008)", async () => {
    const { deps, authRepository, tokenGenerator } = createTestContext();
    await authRepository.createUserWithVerificationToken({
      emailNormalized: "user@example.com",
      passwordHash: "fake-hash:old-password",
      verificationTokenHash: "unused",
      verificationTokenExpiresAt: FUTURE,
    });
    const resetToken = tokenGenerator.generate();
    const user = await authRepository.findUserByEmailNormalized("user@example.com");
    await authRepository.createPasswordResetToken({
      userId: user!.id,
      tokenHash: resetToken.hash,
      expiresAt: FUTURE,
    });

    const result = await confirmPasswordReset(deps, {
      token: resetToken.plaintext,
      newPassword: "new-correct-password",
    });

    expect(result).toEqual({ reset: true });
    const updatedUser = await authRepository.findUserByEmailNormalized("user@example.com");
    expect(updatedUser!.passwordHash).toBe("fake-hash:new-correct-password");
  });

  it("同じtokenの再利用は拒否される(AUTH-INV-001)", async () => {
    const { deps, authRepository, tokenGenerator } = createTestContext();
    await authRepository.createUserWithVerificationToken({
      emailNormalized: "user@example.com",
      passwordHash: "fake-hash:old-password",
      verificationTokenHash: "unused",
      verificationTokenExpiresAt: FUTURE,
    });
    const resetToken = tokenGenerator.generate();
    const user = await authRepository.findUserByEmailNormalized("user@example.com");
    await authRepository.createPasswordResetToken({
      userId: user!.id,
      tokenHash: resetToken.hash,
      expiresAt: FUTURE,
    });

    const first = await confirmPasswordReset(deps, {
      token: resetToken.plaintext,
      newPassword: "new-correct-password",
    });
    const second = await confirmPasswordReset(deps, {
      token: resetToken.plaintext,
      newPassword: "another-password",
    });

    expect(first).toEqual({ reset: true });
    expect(second).toEqual({ reset: false });
  });

  it("期限切れtokenは拒否される", async () => {
    const { deps, authRepository, tokenGenerator } = createTestContext();
    await authRepository.createUserWithVerificationToken({
      emailNormalized: "user@example.com",
      passwordHash: "fake-hash:old-password",
      verificationTokenHash: "unused",
      verificationTokenExpiresAt: FUTURE,
    });
    const resetToken = tokenGenerator.generate();
    const user = await authRepository.findUserByEmailNormalized("user@example.com");
    await authRepository.createPasswordResetToken({
      userId: user!.id,
      tokenHash: resetToken.hash,
      expiresAt: PAST,
    });

    const result = await confirmPasswordReset(deps, {
      token: resetToken.plaintext,
      newPassword: "new-correct-password",
    });

    expect(result).toEqual({ reset: false });
  });

  it("policy違反のnewPasswordはInvalidPasswordErrorを投げる(AUTH-002)", async () => {
    const { deps, tokenGenerator } = createTestContext();
    const resetToken = tokenGenerator.generate();

    await expect(
      confirmPasswordReset(deps, { token: resetToken.plaintext, newPassword: "short" }),
    ).rejects.toThrow(InvalidPasswordError);
  });
});
