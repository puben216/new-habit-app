import { randomBytes, randomUUID } from "node:crypto";

import { expect, type APIRequestContext, type BrowserContext } from "@playwright/test";

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

/**
 * 本物の認証フロー(T-101)で確認済みユーザーを作る: signup → Mailpit から確認 token を取得 → verify-email。
 * DB への直接 insert や認証の迂回はしない。
 */
export async function registerVerifiedUser(
  api: APIRequestContext,
  user: E2eUser = createFakeUser(),
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
  return user;
}

/** signup と確認を終え、さらに Auth.js の credentials callback で session cookie を得る。 */
export async function signUpAndSignIn(
  context: BrowserContext,
  user: E2eUser = createFakeUser(),
): Promise<E2eUser> {
  const api = context.request;
  await registerVerifiedUser(api, user);

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

  return user;
}
