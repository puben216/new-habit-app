/**
 * API 呼び出しの失敗(docs/specs/web-ui-foundation.md WUI-004)。
 *
 * `message` は常に固定の文字列で、server が返した `message` は保持しない(WUI-INV-003)。
 * 画面は `code`/`status` から固定の文言を選び、`fieldErrors` はフォームの項目表示にだけ使う。
 */
export type ApiErrorCode = string;

/** client が付与する code。server の Problem Details の `code` と衝突しない予約名。 */
export const CLIENT_ERROR_CODES = {
  networkError: "network_error",
  invalidResponse: "invalid_response",
  unexpectedResponse: "unexpected_response",
  invalidRequestPath: "invalid_request_path",
} as const;

export interface ApiErrorInit {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly fieldErrors?: Readonly<Record<string, readonly string[]>> | undefined;
  readonly requestId?: string | undefined;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly fieldErrors: Readonly<Record<string, readonly string[]>> | undefined;
  readonly requestId: string | undefined;

  constructor(init: ApiErrorInit) {
    super(`API request failed (status ${init.status})`);
    this.name = "ApiError";
    this.status = init.status;
    this.code = init.code;
    this.fieldErrors = init.fieldErrors;
    this.requestId = init.requestId;
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}
