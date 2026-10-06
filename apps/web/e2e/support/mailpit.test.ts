import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";

import { extractTokenFromEmail, waitForEmail } from "./mailpit";

const BASE = "http://mailpit.test";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** 検索結果とメッセージ詳細を返す Mailpit の fake。 */
function fakeMailpit(messages: ReadonlyArray<{ id: string; subject: string; text: string }>) {
  return vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url.startsWith(`${BASE}/api/v1/search`)) {
      return json({ messages: messages.map((m) => ({ ID: m.id, Subject: m.subject })) });
    }
    const id = url.slice(`${BASE}/api/v1/message/`.length);
    const found = messages.find((m) => m.id === id);
    return found === undefined ? json({}, 404) : json({ Text: found.text });
  });
}

describe("extractTokenFromEmail", () => {
  it("本文中のリンクから token を取り出す", () => {
    const text =
      "以下のリンクからメールアドレスを確認してください。\n\nhttp://localhost:3000/verify-email?token=abc123";
    expect(extractTokenFromEmail(text)).toBe("abc123");
  });

  it("token を含まない URL は飛ばし、最初の token 付き URL を使う", () => {
    const text = "https://example.test/help\nhttps://example.test/verify?token=xyz";
    expect(extractTokenFromEmail(text)).toBe("xyz");
  });

  it("空の token は無効として飛ばし、有効な token がなければ error", () => {
    expect(
      extractTokenFromEmail("https://example.test/a?token=\nhttps://example.test/b?token=ok"),
    ).toBe("ok");
    expect(() => extractTokenFromEmail("https://example.test/a?token=")).toThrow(
      /token 付きのリンク/,
    );
  });

  it("token がない本文は error(本文は error に含めない)", () => {
    expect(() => extractTokenFromEmail("SECRET-BODY https://example.test/")).toThrow(
      /token 付きのリンク/,
    );
    expect(() => extractTokenFromEmail("SECRET-BODY")).not.toThrow(/SECRET-BODY/);
  });

  it("性質: encodeURIComponent した任意の token を往復できる(アプリ側のリンク生成と同じ形式)", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 80 }).filter((v) => !/[\s]/.test(v)),
        (token) => {
          const text = `リンク\n\nhttp://localhost:3000/verify-email?token=${encodeURIComponent(token)}\n`;
          expect(extractTokenFromEmail(text)).toBe(token);
        },
      ),
    );
  });
});

describe("waitForEmail", () => {
  it("宛先で検索し、最新の(先頭の)メール本文を返す", async () => {
    const fetchImpl = fakeMailpit([
      { id: "m2", subject: "メールアドレスの確認", text: "new" },
      { id: "m1", subject: "メールアドレスの確認", text: "old" },
    ]);

    const message = await waitForEmail({ to: "a@example.test", baseUrl: BASE, fetchImpl });

    expect(message.text).toBe("new");
    const searchUrl = String(fetchImpl.mock.calls[0]?.[0]);
    expect(decodeURIComponent(searchUrl)).toContain('to:"a@example.test"');
  });

  it("subject で絞り込む", async () => {
    const fetchImpl = fakeMailpit([
      { id: "m2", subject: "パスワードの再設定", text: "reset" },
      { id: "m1", subject: "メールアドレスの確認", text: "verify" },
    ]);

    const message = await waitForEmail({
      to: "a@example.test",
      subject: "メールアドレスの確認",
      baseUrl: BASE,
      fetchImpl,
    });

    expect(message.text).toBe("verify");
  });

  it("届くまで間隔を置いて再検索する", async () => {
    let calls = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes("/api/v1/search")) {
        calls += 1;
        return json({ messages: calls < 3 ? [] : [{ ID: "m1", Subject: "s" }] });
      }
      return json({ Text: "body" });
    });
    const sleep = vi.fn(async () => undefined);

    const message = await waitForEmail({
      to: "a@example.test",
      baseUrl: BASE,
      fetchImpl,
      sleep,
      intervalMs: 50,
    });

    expect(message.text).toBe("body");
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(50);
  });

  it("届かなければ timeout し、error に宛先と待機時間を含めるが本文は含めない", async () => {
    let clock = 0;
    const fetchImpl = fakeMailpit([]);

    const failure = waitForEmail({
      to: "nobody@example.test",
      baseUrl: BASE,
      fetchImpl,
      timeoutMs: 1000,
      intervalMs: 400,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });

    await expect(failure).rejects.toThrow(/nobody@example\.test.*1000ms/);
  });

  it("Mailpit API の失敗は握りつぶさず error にする", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => json({}, 500));

    await expect(waitForEmail({ to: "a@example.test", baseUrl: BASE, fetchImpl })).rejects.toThrow(
      /500/,
    );
  });

  it("別の宛先のメールは返さない(検索結果が空なら待ち続ける)", async () => {
    let clock = 0;
    const fetchImpl = fakeMailpit([]);

    await expect(
      waitForEmail({
        to: "a@example.test",
        baseUrl: BASE,
        fetchImpl,
        timeoutMs: 10,
        intervalMs: 5,
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
      }),
    ).rejects.toThrow();
  });
});
