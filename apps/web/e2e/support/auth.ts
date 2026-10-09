import { randomBytes, randomUUID } from "node:crypto";

import { expect, request, type APIRequestContext, type BrowserContext } from "@playwright/test";

import { E2E_BASE_URL } from "./e2e-env";
import { extractTokenFromEmail, waitForEmail } from "./mailpit";

export const VERIFY_EMAIL_SUBJECT = "メールアドレスの確認";
export const PASSWORD_RESET_SUBJECT = "パスワードの再設定";

export interface E2eUser {
  readonly email: string;
  readonly password: string;
}

/** 実在しない一意な架空ユーザー(fixture に実在の個人情報を使わない。WUI-INV-007)。 */
export function createFakeUser(): E2eUser {
  return {
    email: `e2e-${randomUUID()}@example.test`,
    // AUTH-002(8〜128 文字、制御文字なし)を満たす、テストごとの使い捨て値。
    password: `Pw-${randomBytes(12).toString("hex")}`,
  };
}

export const E2E_DISPLAY_NAME = "テストユーザー";

export interface RegisterOptions {
  /** true(既定)なら、ログインしてオンボーディング(表示名・タイムゾーン)まで済ませる。 */
  readonly onboarded?: boolean;
}

/** Auth.js の credentials callback で `api` の cookie に session を得る(本物の認証フロー)。 */
async function signInWithApi(api: APIRequestContext, user: E2eUser): Promise<void> {
  const csrf = (await (await api.get(`${E2E_BASE_URL}/api/auth/csrf`)).json()) as {
    csrfToken: string;
  };
  const signIn = await api.post(`${E2E_BASE_URL}/api/auth/callback/credentials`, {
    form: {
      csrfToken: csrf.csrfToken,
      email: user.email,
      password: user.password,
      json: "true",
    },
  });
  expect(signIn.ok(), "credentials callback").toBe(true);

  const session = (await (await api.get(`${E2E_BASE_URL}/api/auth/session`)).json()) as {
    user?: { id?: string };
  };
  expect(session.user?.id, "session user").toBeTruthy();
}

/** セッション済みの `api` でオンボーディング(表示名・タイムゾーン)を完了する。 */
async function completeOnboarding(api: APIRequestContext, displayName: string): Promise<void> {
  const response = await api.patch(`${E2E_BASE_URL}/api/v1/me`, {
    data: { displayName, timezone: "Asia/Tokyo" },
  });
  expect(response.status(), "PATCH /me").toBe(200);
}

/**
 * 本物の認証フロー(T-101)で確認済みユーザーを作る: signup → Mailpit から確認 token を取得 → verify-email。
 * DB への直接 insert や認証の迂回はしない。既定ではオンボーディングまで済ませる(`onboarded: false` で無効化)。
 */
export async function registerVerifiedUser(
  api: APIRequestContext,
  user: E2eUser = createFakeUser(),
  options: RegisterOptions = {},
): Promise<E2eUser> {
  const signup = await api.post(`${E2E_BASE_URL}/api/v1/auth/signup`, {
    data: { email: user.email, password: user.password },
  });
  expect(signup.status(), "signup").toBe(202);

  const message = await waitForEmail({ to: user.email, subject: VERIFY_EMAIL_SUBJECT });
  const verify = await api.post(`${E2E_BASE_URL}/api/v1/auth/verify-email`, {
    data: { token: extractTokenFromEmail(message.text) },
  });
  expect(verify.status(), "verify-email").toBe(200);

  if (options.onboarded !== false) {
    // 別の request context でログインして完了する(呼び出し側の cookie を汚さない)。
    const separate = await request.newContext();
    try {
      await signInWithApi(separate, user);
      await completeOnboarding(separate, E2E_DISPLAY_NAME);
    } finally {
      await separate.dispose();
    }
  }
  return user;
}

/** signup と確認を終え、`context` に session cookie を得る。既定ではオンボーディングも済ませる。 */
export async function signUpAndSignIn(
  context: BrowserContext,
  user: E2eUser = createFakeUser(),
  options: RegisterOptions = {},
): Promise<E2eUser> {
  await registerVerifiedUser(context.request, user, { onboarded: false });
  await signInWithApi(context.request, user);
  if (options.onboarded !== false) await completeOnboarding(context.request, E2E_DISPLAY_NAME);
  return user;
}
