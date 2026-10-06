import { describe, expect, it, vi } from "vitest";

import { ApiError, CLIENT_ERROR_CODES } from "./api-error";
import {
  MAX_QUERY_RETRIES,
  createQueryClient,
  isRetryableError,
  isUnauthorizedError,
} from "./query-client";
import fc from "fast-check";

const apiError = (status: number, code = "some_code") => new ApiError({ status, code });

describe("isRetryableError", () => {
  it("network_error と 5xx は上限まで再試行する", () => {
    expect(isRetryableError(0, apiError(0, CLIENT_ERROR_CODES.networkError))).toBe(true);
    expect(isRetryableError(0, apiError(503))).toBe(true);
    expect(isRetryableError(MAX_QUERY_RETRIES - 1, apiError(500))).toBe(true);
  });

  it("上限に達したら再試行しない", () => {
    expect(isRetryableError(MAX_QUERY_RETRIES, apiError(503))).toBe(false);
  });

  it("契約不一致(status 200 の invalid_response)と ApiError 以外は再試行しない", () => {
    expect(isRetryableError(0, apiError(200, CLIENT_ERROR_CODES.invalidResponse))).toBe(false);
    expect(isRetryableError(0, new Error("boom"))).toBe(false);
    expect(isRetryableError(0, "string")).toBe(false);
  });

  it("性質: 任意の 4xx は失敗回数にかかわらず再試行しない", () => {
    fc.assert(
      fc.property(fc.integer({ min: 400, max: 499 }), fc.nat(10), (status, failureCount) => {
        expect(isRetryableError(failureCount, apiError(status))).toBe(false);
      }),
    );
  });

  it("性質: 失敗回数が上限以上なら任意の error で再試行しない", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 599 }),
        fc.integer({ min: MAX_QUERY_RETRIES, max: 50 }),
        (status, failureCount) => {
          expect(isRetryableError(failureCount, apiError(status))).toBe(false);
        },
      ),
    );
  });
});

describe("isUnauthorizedError", () => {
  it("status 401 の ApiError だけが true", () => {
    expect(isUnauthorizedError(apiError(401))).toBe(true);
    expect(isUnauthorizedError(apiError(403))).toBe(false);
    expect(isUnauthorizedError(new Error("401"))).toBe(false);
    expect(isUnauthorizedError({ status: 401 })).toBe(false);
  });
});

describe("createQueryClient", () => {
  it("query が 401 で失敗したとき onUnauthorized を client 付きで 1 回だけ呼ぶ", async () => {
    const onUnauthorized = vi.fn();
    const client = createQueryClient({ onUnauthorized });

    await expect(
      client.fetchQuery({
        queryKey: ["a"],
        queryFn: () => Promise.reject(apiError(401)),
        retry: false,
      }),
    ).rejects.toBeInstanceOf(ApiError);
    await expect(
      client.fetchQuery({
        queryKey: ["b"],
        queryFn: () => Promise.reject(apiError(401)),
        retry: false,
      }),
    ).rejects.toBeInstanceOf(ApiError);

    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(onUnauthorized).toHaveBeenCalledWith(client);
  });

  it("mutation が 401 で失敗した場合も onUnauthorized を呼ぶ", async () => {
    const onUnauthorized = vi.fn();
    const client = createQueryClient({ onUnauthorized });

    await expect(
      client
        .getMutationCache()
        .build(client, { mutationFn: () => Promise.reject(apiError(401)) })
        .execute(undefined),
    ).rejects.toBeInstanceOf(ApiError);

    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("401 以外の失敗では onUnauthorized を呼ばない", async () => {
    const onUnauthorized = vi.fn();
    const client = createQueryClient({ onUnauthorized });

    await expect(
      client.fetchQuery({
        queryKey: ["a"],
        queryFn: () => Promise.reject(apiError(403)),
        retry: false,
      }),
    ).rejects.toBeInstanceOf(ApiError);

    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("既定で mutation は再試行せず、query は isRetryableError を使う", () => {
    const client = createQueryClient({ onUnauthorized: () => undefined });
    const defaults = client.getDefaultOptions();

    expect(defaults.mutations?.retry).toBe(false);
    expect(defaults.queries?.retry).toBe(isRetryableError);
  });
});
