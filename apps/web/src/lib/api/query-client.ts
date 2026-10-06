import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";

import { CLIENT_ERROR_CODES, isApiError } from "./api-error";

/** docs/specs/web-ui-foundation.md WUI-005。query の再試行は一時的な失敗に限る。 */
export const MAX_QUERY_RETRIES = 2;

export function isUnauthorizedError(error: unknown): boolean {
  return isApiError(error) && error.status === 401;
}

/** network 失敗と 5xx だけを再試行する。4xx・契約不一致・想定外の例外は再試行しない。 */
export function isRetryableError(failureCount: number, error: unknown): boolean {
  if (failureCount >= MAX_QUERY_RETRIES) return false;
  if (!isApiError(error)) return false;
  return error.code === CLIENT_ERROR_CODES.networkError || error.status >= 500;
}

export interface QueryClientOptions {
  /** `401` を受けたとき(session 失効)に呼ばれる。多重呼び出しは 1 回にまとめる。 */
  readonly onUnauthorized: (queryClient: QueryClient) => void;
}

export function createQueryClient(options: QueryClientOptions): QueryClient {
  let handled = false;

  // `handleError` は cache の生成時に渡すが、実行は QueryClient の生成後になる。
  function handleError(error: unknown): void {
    if (!isUnauthorizedError(error) || handled) return;
    handled = true;
    options.onUnauthorized(client);
  }

  const client = new QueryClient({
    queryCache: new QueryCache({ onError: handleError }),
    mutationCache: new MutationCache({ onError: handleError }),
    defaultOptions: {
      queries: { retry: isRetryableError, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
  return client;
}
