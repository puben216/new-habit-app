import { describe, expect, it, vi } from "vitest";
import { login } from "./login";
import { verifyEmail } from "./verify-email";
import {
  createFakeAuthRepository,
  createFakePasswordHasher,
  createFakeTokenGenerator,
  createFixedClock,
} from "./test-fakes";

const DUMMY_HASH = "fake-hash:dummy-placeholder";
const NOW = new Date("2026-01-01T00:00:00Z");
const FUTURE = new Date("2026-01-02T00:00:00Z");

function createTestContext() {
  const authRepository = createFakeAuthRepository();
  const passwordHasher = createFakePasswordHasher();
  const tokenGenerator = createFakeTokenGenerator();
  const now = createFixedClock(NOW);
  return {
    authRepository,
    passwordHasher,
    tokenGenerator,
    verifyDeps: { authRepository, tokenGenerator, now },
    deps: { authRepository, passwordHasher, dummyPasswordHash: DUMMY_HASH },
  };
}

async function createVerifiedUser(
  context: ReturnType<typeof createTestContext>,
  email: string,
  passwordHash: string,
) {
  const token = context.tokenGenerator.generate();
  await context.authRepository.createUserWithVerificationToken({
    emailNormalized: email,
    passwordHash,
    verificationTokenHash: token.hash,
    verificationTokenExpiresAt: FUTURE,
  });
  await verifyEmail(context.verifyDeps, { token: token.plaintext });
  return context.authRepository.findUserByEmailNormalized(email);
}

describe("login", () => {
  it("正しいemail/passwordでかつ確認済みならログイン成功しuserIdを返す(AUTH-005)", async () => {
    const context = createTestContext();
    const user = await createVerifiedUser(
      context,
      "user@example.com",
      "fake-hash:correct-password",
    );

    const result = await login(context.deps, {
      email: "user@example.com",
      password: "correct-password",
    });

    expect(result).toEqual({ ok: true, userId: user!.id });
  });

  it("存在しないemailでもdummyハッシュのverifyが呼ばれ、失敗として扱う(AUTH-INV-002)", async () => {
    const context = createTestContext();
    const verifySpy = vi.spyOn(context.passwordHasher, "verify");

    const result = await login(context.deps, {
      email: "unknown@example.com",
      password: "whatever",
    });

    expect(result).toEqual({ ok: false });
    expect(verifySpy).toHaveBeenCalledWith("whatever", DUMMY_HASH);
  });

  it("パスワード不一致は失敗を返す(AUTH-005)", async () => {
    const context = createTestContext();
    await createVerifiedUser(context, "user@example.com", "fake-hash:correct-password");

    const result = await login(context.deps, {
      email: "user@example.com",
      password: "wrong-password",
    });

    expect(result).toEqual({ ok: false });
  });

  it("email未確認のアカウントは正しいパスワードでも失敗する(AUTH-005)", async () => {
    const context = createTestContext();
    await context.authRepository.createUserWithVerificationToken({
      emailNormalized: "user@example.com",
      passwordHash: "fake-hash:correct-password",
      verificationTokenHash: "unused-token-hash",
      verificationTokenExpiresAt: FUTURE,
    });

    const result = await login(context.deps, {
      email: "user@example.com",
      password: "correct-password",
    });

    expect(result).toEqual({ ok: false });
  });
});
