import { describe, expect, it, vi } from "vitest";

import { createUnsubscribeHandlers } from "./unsubscribe-handlers";
import type { UnsubscribeHandlerDeps } from "./unsubscribe-handlers";

const BASE = "https://app.example.test/api/v1/notification-unsubscribe";

function setup(valid = "good.token.value") {
  const deps = {
    isValidToken: vi.fn((token: string) => token === valid),
    unsubscribe: vi.fn<UnsubscribeHandlerDeps["unsubscribe"]>(async (token) =>
      token === valid ? "unsubscribed" : "invalid_token",
    ),
  };
  return { deps, handlers: createUnsubscribeHandlers(deps) };
}

const get = (token?: string) =>
  new Request(token === undefined ? BASE : `${BASE}?token=${encodeURIComponent(token)}`);
const post = (
  token?: string,
  headers: Record<string, string> = {},
  body = "List-Unsubscribe=One-Click",
) =>
  new Request(token === undefined ? BASE : `${BASE}?token=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body,
  });

async function problem(response: Response) {
  return (await response.json()) as { code: string };
}

describe("GET /notification-unsubscribe", () => {
  it("有効な token なら確認画面(HTML)を返し、状態を変えない。token を応答の外へ漏らさない", async () => {
    const { handlers, deps } = setup();
    const response = await handlers.get(get("good.token.value"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    const html = await response.text();
    expect(html).toContain('method="post"');
    expect(html).toContain("token=good.token.value");
    expect(deps.unsubscribe).not.toHaveBeenCalled();
  });

  it("不正・欠落・長すぎる token は 400 invalid_token(理由を区別しない)", async () => {
    const { handlers, deps } = setup();
    for (const token of ["bad", undefined, "", "a".repeat(513)]) {
      const response = await handlers.get(get(token));
      expect(response.status).toBe(400);
      expect((await problem(response)).code).toBe("invalid_token");
    }
    expect(deps.unsubscribe).not.toHaveBeenCalled();
  });

  it("HTML に埋め込む token は属性として安全にエスケープされる", async () => {
    const hostile = 'x"><script>alert(1)</script>';
    const { handlers } = setup(hostile);
    const html = await (await handlers.get(get(hostile))).text();
    expect(html).not.toContain("<script>");
    expect(html).not.toContain(hostile);
    expect(html).toContain(encodeURIComponent(hostile));
  });
});

describe("POST /notification-unsubscribe", () => {
  it("有効な token で 200 { status: unsubscribed }。2 回呼んでも同じ", async () => {
    const { handlers, deps } = setup();
    for (let i = 0; i < 2; i += 1) {
      const response = await handlers.post(post("good.token.value"));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: "unsubscribed" });
    }
    expect(deps.unsubscribe).toHaveBeenCalledWith("good.token.value");
  });

  it("ブラウザ(Accept: text/html)には完了画面を返す", async () => {
    const { handlers } = setup();
    const response = await handlers.post(post("good.token.value", { accept: "text/html" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain("配信を停止しました");
  });

  it("body の内容にかかわらず query の token だけで判断する(body は読まない)", async () => {
    const { handlers } = setup();
    expect((await handlers.post(post("good.token.value", {}, ""))).status).toBe(200);
    expect((await handlers.post(post("good.token.value", {}, "x".repeat(100_000)))).status).toBe(
      200,
    );
  });

  it("不正な token は 400 で、use case を呼ばない/何も変更しない", async () => {
    const { handlers } = setup();
    const response = await handlers.post(post("bad"));
    expect(response.status).toBe(400);
    expect((await problem(response)).code).toBe("invalid_token");
    expect((await handlers.post(post(undefined))).status).toBe(400);
  });

  it("未知のエラーは再 throw する(内部情報を応答に含めない)", async () => {
    const { handlers, deps } = setup();
    deps.unsubscribe.mockRejectedValueOnce(new Error("db down"));
    await expect(handlers.post(post("good.token.value"))).rejects.toThrow();
  });
});
