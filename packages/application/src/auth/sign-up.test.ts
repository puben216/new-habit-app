import { InvalidPasswordError } from "@habit-app/domain";
import { describe, expect, it, vi } from "vitest";
import type { EmailSenderPort } from "./ports";
import { signUp } from "./sign-up";
import {
  createFakeAuthRepository,
  createFakeEmailSender,
  createFakePasswordHasher,
  createFakeTokenGenerator,
  createFixedClock,
} from "./test-fakes";

function createTestContext() {
  const authRepository = createFakeAuthRepository();
  const emailSender = createFakeEmailSender();
  return {
    authRepository,
    emailSender,
    deps: {
      authRepository,
      passwordHasher: createFakePasswordHasher(),
      tokenGenerator: createFakeTokenGenerator(),
      emailSender,
      now: createFixedClock(new Date("2026-01-01T00:00:00Z")),
    },
  };
}

describe("signUp", () => {
  it("新規emailでsignupするとaccountが作成されverification通知が送られる(AUTH-001)", async () => {
    const { deps, authRepository, emailSender } = createTestContext();

    const result = await signUp(deps, {
      email: "User@Example.com",
      password: "correct-horse-battery",
    });

    expect(result).toEqual({ accepted: true });
    expect(authRepository.usersByEmail.has("user@example.com")).toBe(true);
    expect(emailSender.sentVerificationEmails).toHaveLength(1);
  });

  it("登録済みemailで再度signupしても新規signupと区別できない応答が返り、accountは重複作成されない(AUTH-INV-002)", async () => {
    const { deps, authRepository, emailSender } = createTestContext();
    const input = { email: "user@example.com", password: "correct-horse-battery" };

    const first = await signUp(deps, input);
    const second = await signUp(deps, input);

    expect(first).toEqual({ accepted: true });
    expect(second).toEqual({ accepted: true });
    expect(authRepository.usersByEmail.size).toBe(1);
    expect(emailSender.sentVerificationEmails).toHaveLength(1);
  });

  it("password policy違反時はInvalidPasswordErrorを投げる(AUTH-002)", async () => {
    const { deps, authRepository } = createTestContext();

    await expect(signUp(deps, { email: "user@example.com", password: "short" })).rejects.toThrow(
      InvalidPasswordError,
    );
    expect(authRepository.usersByEmail.size).toBe(0);
  });

  it("通知メール送信が失敗してもaccountは作成され応答は変わらない(AUTH-INV-002)", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { deps, authRepository } = createTestContext();
    const failingEmailSender: EmailSenderPort = {
      async sendVerificationEmail() {
        throw new Error("smtp down");
      },
      async sendPasswordResetEmail() {
        throw new Error("smtp down");
      },
    };

    const result = await signUp(
      { ...deps, emailSender: failingEmailSender },
      { email: "user@example.com", password: "correct-horse-battery" },
    );

    expect(result).toEqual({ accepted: true });
    expect(authRepository.usersByEmail.has("user@example.com")).toBe(true);
    consoleErrorSpy.mockRestore();
  });
});
