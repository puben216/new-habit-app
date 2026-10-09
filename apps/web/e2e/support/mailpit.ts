import { E2E_MAILPIT_HTTP_URL } from "./e2e-env";

/**
 * Mailpit の HTTP API からメールを取得する helper(WUI-008)。
 * 宛先で絞り込み、timeout 付きで待機する。失敗時の error には宛先と待機時間だけを含め、本文は含めない。
 */
export interface EmailMessage {
  readonly id: string;
  readonly subject: string;
  readonly text: string;
}

export interface WaitForEmailOptions {
  readonly to: string;
  readonly subject?: string;
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_INTERVAL_MS = 250;

interface MailpitSummary {
  readonly ID?: unknown;
  readonly Subject?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function getJson(fetchImpl: typeof fetch, url: string): Promise<unknown> {
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`Mailpit API が ${response.status} を返しました`);
  return response.json();
}

async function findMessage(
  fetchImpl: typeof fetch,
  baseUrl: string,
  to: string,
  subject: string | undefined,
): Promise<EmailMessage | undefined> {
  const query = encodeURIComponent(`to:"${to}"`);
  const search = await getJson(fetchImpl, `${baseUrl}/api/v1/search?query=${query}`);
  const messages = isRecord(search) && Array.isArray(search["messages"]) ? search["messages"] : [];

  // 検索結果は新しい順。条件に合う最初(最新)のメールを使う。
  for (const summary of messages as MailpitSummary[]) {
    if (typeof summary.ID !== "string") continue;
    if (subject !== undefined && summary.Subject !== subject) continue;
    const detail = await getJson(fetchImpl, `${baseUrl}/api/v1/message/${summary.ID}`);
    if (!isRecord(detail) || typeof detail["Text"] !== "string") continue;
    return {
      id: summary.ID,
      subject: typeof summary.Subject === "string" ? summary.Subject : "",
      text: detail["Text"],
    };
  }
  return undefined;
}

export async function waitForEmail(options: WaitForEmailOptions): Promise<EmailMessage> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl ?? E2E_MAILPIT_HTTP_URL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = options.now ?? Date.now;

  const deadline = now() + timeoutMs;
  for (;;) {
    const message = await findMessage(fetchImpl, baseUrl, options.to, options.subject);
    if (message !== undefined) return message;
    if (now() >= deadline) break;
    await sleep(intervalMs);
  }
  throw new Error(
    `宛先 ${options.to} のメールが ${timeoutMs}ms 以内に Mailpit へ届きませんでした(Mailpit の起動とアプリの SMTP 設定を確認してください)`,
  );
}

/** メール本文中の最初の `?token=` 付き URL から token を取り出す。見つからなければ error。 */
export function extractTokenFromEmail(text: string): string {
  for (const candidate of text.match(/https?:\/\/\S+/g) ?? []) {
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      continue;
    }
    const token = url.searchParams.get("token");
    if (token !== null && token.length > 0) return token;
  }
  throw new Error("メール本文に token 付きのリンクが見つかりませんでした");
}
