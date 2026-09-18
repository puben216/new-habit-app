import { describe, expect, it } from "vitest";
import { createArgon2PasswordHasher, createDummyPasswordHash } from "./argon2-password-hasher";

describe("createArgon2PasswordHasher", () => {
  it("正しいpasswordで検証に成功する", async () => {
    const hasher = createArgon2PasswordHasher();
    const hash = await hasher.hash("correct horse battery staple");

    await expect(hasher.verify("correct horse battery staple", hash)).resolves.toBe(true);
  });

  it("誤ったpasswordで検証に失敗する", async () => {
    const hasher = createArgon2PasswordHasher();
    const hash = await hasher.hash("correct horse battery staple");

    await expect(hasher.verify("wrong password", hash)).resolves.toBe(false);
  });

  it("argon2形式でないhashに対してもエラーを投げず検証失敗を返す", async () => {
    const hasher = createArgon2PasswordHasher();

    await expect(hasher.verify("any password", "not-an-argon2-hash")).resolves.toBe(false);
  });

  it("同一passwordでも呼び出しごとにhashが異なる(salt)", async () => {
    const hasher = createArgon2PasswordHasher();
    const first = await hasher.hash("same password");
    const second = await hasher.hash("same password");

    expect(first).not.toBe(second);
  });
});

describe("createDummyPasswordHash", () => {
  it("PasswordHasherPortでverifyできる形式のhashを返す", async () => {
    const hasher = createArgon2PasswordHasher();
    const dummyHash = await createDummyPasswordHash(hasher);

    await expect(hasher.verify("anything", dummyHash)).resolves.toBe(false);
  });
});
