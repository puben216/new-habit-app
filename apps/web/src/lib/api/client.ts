import { z } from "zod";

import { ApiError, CLIENT_ERROR_CODES } from "./api-error";
import { isSafeApiPath } from "./api-path";

/**
 * 型付き API client(ADR-009、ADR-010、docs/specs/web-ui-foundation.md WUI-004)。
 *
 * 画面は素の `fetch` を呼ばず、必ずこの関数を通す。応答は呼び出し側が渡す runtime schema で
 * 検証する。request/response の body、email、token はログへ出さない(`console` を使わない)。
 */
export const DEFAULT_TIMEOUT_MS = 10_000;

export type ApiMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface ApiRequestOptions<T> {
  readonly path: string;
  readonly schema: z.ZodType<T>;
  readonly method?: ApiMethod;
  readonly body?: unknown;
  /** `If-Match`・冪等性 key など、画面が指定する追加 header。`Content-Type` は上書きできない。 */
  readonly headers?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /** テスト用の注入口。省略時は global の `fetch`。 */
  readonly fetchImpl?: typeof fetch;
}

const problemDetailsSchema = z.object({
  code: z.string().min(1),
  message: z.string(),
  fieldErrors: z.record(z.string(), z.array(z.string())).optional(),
  requestId: z.string().optional(),
});

function networkError(): ApiError {
  return new ApiError({ status: 0, code: CLIENT_ERROR_CODES.networkError });
}

async function readJson(response: Response): Promise<{ ok: true; value: unknown } | { ok: false }> {
  try {
    return { ok: true, value: await response.json() };
  } catch {
    return { ok: false };
  }
}

async function toApiError(response: Response): Promise<ApiError> {
  const json = await readJson(response);
  const problem = json.ok ? problemDetailsSchema.safeParse(json.value) : undefined;
  if (problem?.success !== true) {
    return new ApiError({ status: response.status, code: CLIENT_ERROR_CODES.unexpectedResponse });
  }
  return new ApiError({
    status: response.status,
    code: problem.data.code,
    fieldErrors: problem.data.fieldErrors,
    requestId: problem.data.requestId,
  });
}

export async function apiRequest<T>(options: ApiRequestOptions<T>): Promise<T> {
  if (!isSafeApiPath(options.path)) {
    throw new ApiError({ status: 0, code: CLIENT_ERROR_CODES.invalidRequestPath });
  }

  const method = options.method ?? "GET";
  const hasBody = options.body !== undefined;
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...options.headers,
  };
  if (hasBody) headers["Content-Type"] = "application/json";

  const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal =
    options.signal === undefined ? timeoutSignal : AbortSignal.any([options.signal, timeoutSignal]);

  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(options.path, {
      method,
      headers,
      ...(hasBody ? { body: JSON.stringify(options.body) } : {}),
      credentials: "same-origin",
      cache: "no-store",
      signal,
    });
  } catch (error) {
    // 呼び出し側の取り消しは失敗として扱わず、そのまま伝える(TanStack Query のキャンセル用)。
    if (options.signal?.aborted === true) throw error;
    throw networkError();
  }

  if (!response.ok) throw await toApiError(response);

  const json =
    response.status === 204 ? { ok: true as const, value: undefined } : await readJson(response);
  const parsed = json.ok ? options.schema.safeParse(json.value) : undefined;
  if (parsed?.success !== true) {
    throw new ApiError({ status: response.status, code: CLIENT_ERROR_CODES.invalidResponse });
  }
  return parsed.data;
}
