import { z } from "zod";

import { ApiError, CLIENT_ERROR_CODES } from "@/lib/api/api-error";

/**
 * Auth.js 標準 endpoint の client(docs/specs/auth-screens.md AUI-004、AUI-008)。
 *
 * Auth.js の endpoint は `/api/v1` の例外(ADR-009)で、型付き API client の対象外。画面から直接
 * 呼ばず、ここに集約する。ログインの成否は callback の応答本文ではなく、DB session 由来の
 * session 応答(`user.id`)で判定する(AUI-INV-006)。失敗の種類は区別しない(AUI-INV-001)。
 */
const AUTH_BASE = "/api/auth";
const TIMEOUT_MS = 10_000;

const csrfSchema = z.object({ csrfToken: z.string().min(1) });
const sessionSchema = z
  .object({
    user: z
      .object({ id: z.string().min(1) })
      .partial()
      .optional(),
  })
  .nullable();

export interface AuthClientOptions {
  /** テスト用の注入口。省略時は global の `fetch`。 */
  readonly fetchImpl?: typeof fetch;
}

export interface SignInInput extends AuthClientOptions {
  readonly email: string;
  readonly password: string;
}

export type SignInResult = "success" | "invalid_credentials";

function networkError(): ApiError {
  return new ApiError({ status: 0, code: CLIENT_ERROR_CODES.networkError });
}

async function send(
  fetchImpl: typeof fetch,
  path: string,
  init: { method: "GET" | "POST"; form?: URLSearchParams },
): Promise<Response> {
  try {
    return await fetchImpl(`${AUTH_BASE}${path}`, {
      method: init.method,
      headers:
        init.form === undefined
          ? { Accept: "application/json" }
          : { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      ...(init.form === undefined ? {} : { body: init.form.toString() }),
      credentials: "same-origin",
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw networkError();
  }
}

async function fetchCsrfToken(fetchImpl: typeof fetch): Promise<string> {
  const response = await send(fetchImpl, "/csrf", { method: "GET" });
  const parsed = csrfSchema.safeParse(await response.json().catch(() => undefined));
  if (!response.ok || !parsed.success) {
    throw new ApiError({
      status: response.status,
      code: CLIENT_ERROR_CODES.unexpectedResponse,
    });
  }
  return parsed.data.csrfToken;
}

async function hasValidSession(fetchImpl: typeof fetch): Promise<boolean> {
  const response = await send(fetchImpl, "/session", { method: "GET" });
  if (!response.ok) return false;
  const parsed = sessionSchema.safeParse(await response.json().catch(() => undefined));
  return parsed.success && typeof parsed.data?.user?.id === "string";
}

export async function signInWithPassword(input: SignInInput): Promise<SignInResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const csrfToken = await fetchCsrfToken(fetchImpl);

  // 応答の status・本文は成否の判定に使わない(失敗の種類を作らない)。
  await send(fetchImpl, "/callback/credentials", {
    method: "POST",
    form: new URLSearchParams({
      csrfToken,
      email: input.email,
      password: input.password,
      json: "true",
    }),
  });

  return (await hasValidSession(fetchImpl)) ? "success" : "invalid_credentials";
}

export async function signOut(options: AuthClientOptions = {}): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const csrfToken = await fetchCsrfToken(fetchImpl);
  const response = await send(fetchImpl, "/signout", {
    method: "POST",
    form: new URLSearchParams({ csrfToken, json: "true" }),
  });
  if (!response.ok) {
    throw new ApiError({ status: response.status, code: CLIENT_ERROR_CODES.unexpectedResponse });
  }
}
