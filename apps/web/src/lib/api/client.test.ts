import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { ApiError, CLIENT_ERROR_CODES } from "./api-error";
import { apiRequest } from "./client";

const habitSchema = z.object({ id: z.string(), name: z.string() });

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function catchError(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error("ApiError が投げられなかった");
}

describe("apiRequest", () => {
  it("schema に合う応答を型付きで返し、同一 origin の JSON request を送る", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ id: "h1", name: "散歩" }));

    const result = await apiRequest({
      method: "PUT",
      path: "/api/v1/habits/h1",
      schema: habitSchema,
      body: { name: "散歩" },
      headers: { "If-Match": '"v3"' },
      fetchImpl,
    });

    expect(result).toEqual({ id: "h1", name: "散歩" });
    const [path, init] = fetchImpl.mock.calls[0] ?? [];
    expect(path).toBe("/api/v1/habits/h1");
    expect(init?.method).toBe("PUT");
    expect(init?.credentials).toBe("same-origin");
    expect(init?.body).toBe(JSON.stringify({ name: "散歩" }));
    expect(init?.headers).toMatchObject({
      Accept: "application/json",
      "Content-Type": "application/json",
      "If-Match": '"v3"',
    });
  });

  it("body がない request は Content-Type を付けず body も送らない", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ id: "h1", name: "散歩" }));

    await apiRequest({ path: "/api/v1/habits/h1", schema: habitSchema, fetchImpl });

    const [, init] = fetchImpl.mock.calls[0] ?? [];
    expect(init?.method).toBe("GET");
    expect(init?.body).toBeUndefined();
    expect(init?.headers).not.toHaveProperty("Content-Type");
  });

  it("追加 header で Content-Type を上書きできない", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ id: "h1", name: "x" }));

    await apiRequest({
      method: "POST",
      path: "/api/v1/habits",
      schema: habitSchema,
      body: {},
      headers: { "Content-Type": "text/plain" },
      fetchImpl,
    });

    const [, init] = fetchImpl.mock.calls[0] ?? [];
    expect(init?.headers).toMatchObject({ "Content-Type": "application/json" });
  });

  it("204 は schema が undefined を許す場合に成功する", async () => {
    const fetchImpl = async () => new Response(null, { status: 204 });

    await expect(
      apiRequest({
        method: "DELETE",
        path: "/api/v1/habits/h1",
        schema: z.undefined(),
        fetchImpl,
      }),
    ).resolves.toBeUndefined();
  });

  it("Problem Details を ApiError にし、server の message は保持しない", async () => {
    const fetchImpl = async () =>
      jsonResponse(
        {
          code: "validation_failed",
          message: "SECRET internal detail: SELECT * FROM users",
          fieldErrors: { name: ["必須です"] },
          requestId: "req-1",
        },
        422,
      );

    const error = await catchError(
      apiRequest({ path: "/api/v1/habits", schema: habitSchema, fetchImpl }),
    );

    expect(error.status).toBe(422);
    expect(error.code).toBe("validation_failed");
    expect(error.fieldErrors).toEqual({ name: ["必須です"] });
    expect(error.requestId).toBe("req-1");
    expect(error.message).not.toContain("SECRET");
    expect(String(error)).not.toContain("SECRET");
  });

  it("401 は status 401 の ApiError として返す", async () => {
    const fetchImpl = async () => jsonResponse({ code: "unauthenticated", message: "x" }, 401);

    const error = await catchError(
      apiRequest({ path: "/api/v1/me", schema: habitSchema, fetchImpl }),
    );

    expect(error.status).toBe(401);
  });

  it("Problem Details として解釈できないエラー応答は unexpected_response", async () => {
    const fetchImpl = async () => new Response("<html>Bad Gateway</html>", { status: 502 });

    const error = await catchError(
      apiRequest({ path: "/api/v1/habits", schema: habitSchema, fetchImpl }),
    );

    expect(error.status).toBe(502);
    expect(error.code).toBe(CLIENT_ERROR_CODES.unexpectedResponse);
  });

  it("成功応答が schema に合わなければ invalid_response", async () => {
    const fetchImpl = async () => jsonResponse({ id: 1 });

    const error = await catchError(
      apiRequest({ path: "/api/v1/habits/h1", schema: habitSchema, fetchImpl }),
    );

    expect(error.status).toBe(200);
    expect(error.code).toBe(CLIENT_ERROR_CODES.invalidResponse);
  });

  it("成功応答が JSON でなければ invalid_response", async () => {
    const fetchImpl = async () => new Response("not json", { status: 200 });

    const error = await catchError(
      apiRequest({ path: "/api/v1/habits/h1", schema: habitSchema, fetchImpl }),
    );

    expect(error.code).toBe(CLIENT_ERROR_CODES.invalidResponse);
  });

  it("network 失敗は network_error(元の error の内容を含めない)", async () => {
    const fetchImpl = async () => {
      throw new TypeError("connect ECONNREFUSED 10.0.0.1:443 secret-host");
    };

    const error = await catchError(
      apiRequest({ path: "/api/v1/habits", schema: habitSchema, fetchImpl }),
    );

    expect(error.code).toBe(CLIENT_ERROR_CODES.networkError);
    expect(error.message).not.toContain("secret-host");
  });

  it("timeout は network_error になり、fetch に渡した signal が abort される", async () => {
    let received: AbortSignal | undefined;
    const fetchImpl = (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        received = init?.signal ?? undefined;
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });

    const error = await catchError(
      apiRequest({ path: "/api/v1/habits", schema: habitSchema, fetchImpl, timeoutMs: 20 }),
    );

    expect(error.code).toBe(CLIENT_ERROR_CODES.networkError);
    expect(received?.aborted).toBe(true);
  });

  it("呼び出し側の取り消しは ApiError にせず元の abort をそのまま伝える", async () => {
    const controller = new AbortController();
    const fetchImpl = (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });

    const pending = apiRequest({
      path: "/api/v1/habits",
      schema: habitSchema,
      fetchImpl,
      signal: controller.signal,
    });
    controller.abort(new DOMException("cancelled", "AbortError"));

    await expect(pending).rejects.not.toBeInstanceOf(ApiError);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it.each(["https://evil.example/x", "//evil.example", "/api/v1/../auth", "/api/auth/session"])(
    "安全でない path %s は request を送らずに拒否する",
    async (path) => {
      const fetchImpl = vi.fn<typeof fetch>();

      const error = await catchError(apiRequest({ path, schema: habitSchema, fetchImpl }));

      expect(error.code).toBe(CLIENT_ERROR_CODES.invalidRequestPath);
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );
});
