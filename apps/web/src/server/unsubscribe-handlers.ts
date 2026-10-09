import type { UnsubscribeOutcome } from "@habit-app/application";
import { unsubscribeQuerySchema } from "@habit-app/contracts";

import { jsonResponse, problemResponse } from "./habit-http";

/**
 * `/api/v1/notification-unsubscribe` の route handler 本体(docs/specs/notification-delivery.md NDL-007)。
 *
 * 認証不要の公開 endpoint で、署名付き token が唯一の資格情報。Origin 検証は行わない
 * (メールクライアント・ブラウザの外から POST されるため)。状態を変えるのは POST のみで、
 * GET はメーラーのプリフェッチで勝手に停止されないよう確認画面を返すだけ。
 * token を応答・ログに含めない。不正な token の理由は区別しない。
 */

export interface UnsubscribeHandlerDeps {
  /** token の署名・形式が正しいか(状態を変えない)。 */
  readonly isValidToken: (token: string) => boolean;
  readonly unsubscribe: (token: string) => Promise<UnsubscribeOutcome>;
}

export interface UnsubscribeHandlers {
  get(request: Request): Promise<Response>;
  post(request: Request): Promise<Response>;
}

const HTML_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  // token を含む URL を外部へ漏らさない。
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; form-action 'self'; frame-ancestors 'none'",
} as const;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function page(body: string): string {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>通知の配信停止</title></head><body>${body}</body></html>`;
}

function invalidTokenResponse(): Response {
  return problemResponse(400, { code: "invalid_token", message: "リンクが無効です" });
}

function wantsHtml(request: Request): boolean {
  return (request.headers.get("accept") ?? "").includes("text/html");
}

function readToken(request: Request): string | null {
  const parsed = unsubscribeQuerySchema.safeParse({
    token: new URL(request.url).searchParams.get("token") ?? "",
  });
  return parsed.success ? parsed.data.token : null;
}

export function createUnsubscribeHandlers(deps: UnsubscribeHandlerDeps): UnsubscribeHandlers {
  return {
    async get(request) {
      const token = readToken(request);
      if (token === null || !deps.isValidToken(token)) return invalidTokenResponse();

      const action = `?token=${encodeURIComponent(token)}`;
      return new Response(
        page(
          `<main><h1>リマインド通知の配信停止</h1><p>リマインドメールの配信を停止します。</p><form method="post" action="${escapeHtml(action)}"><button type="submit">配信を停止する</button></form></main>`,
        ),
        { status: 200, headers: HTML_HEADERS },
      );
    },

    async post(request) {
      const token = readToken(request);
      if (token === null) return invalidTokenResponse();

      const outcome = await deps.unsubscribe(token);
      if (outcome === "invalid_token") return invalidTokenResponse();

      if (wantsHtml(request)) {
        return new Response(
          page(
            "<main><h1>配信を停止しました</h1><p>リマインドメールの配信を停止しました。設定は、アプリの通知設定からいつでも変更できます。</p></main>",
          ),
          { status: 200, headers: HTML_HEADERS },
        );
      }
      return jsonResponse(200, { status: "unsubscribed" });
    },
  };
}
