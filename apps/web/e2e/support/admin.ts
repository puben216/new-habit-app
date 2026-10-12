import { createHmac } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";

import pg from "pg";

import { E2E_ADMIN_TOTP_ENCRYPTION_KEY, E2E_DATABASE_URL } from "./e2e-env";

/**
 * 管理機能(T-403)の E2E 支援。Admin は本物の運用スクリプト(`pnpm admin:grant`)で作り、
 * TOTP は RFC 6238 を独立に実装して生成する(アプリの実装とは共有しない)。
 * ここにある鍵・コードはローカル/CI 専用の使い捨てで、実在の Secret ではない。
 */

// Playwright は apps/web で実行される(`pnpm --filter web test:e2e`)。リポジトリのルートはその 2 つ上。
const REPO_ROOT = path.resolve(process.cwd(), "../..");

export interface ProvisionedAdmin {
  readonly publicId: string;
  readonly totpSecret: Buffer;
  readonly recoveryCodes: readonly string[];
}

function runAdminCli(command: "grant" | "disable" | "reset-mfa", email: string): string {
  const result = spawnSync("pnpm", [`admin:${command}`, "--email", email], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      DATABASE_URL: E2E_DATABASE_URL,
      ADMIN_TOTP_ENCRYPTION_KEY: E2E_ADMIN_TOTP_ENCRYPTION_KEY,
    },
  });
  if (result.status !== 0) {
    // 出力に秘密を含みうるため、終了コードだけを伝える。
    throw new Error(`pnpm admin:${command} が失敗しました(終了コード ${String(result.status)})`);
  }
  return result.stdout;
}

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(text: string): Buffer {
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of text.toUpperCase()) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error("invalid base32");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** 確認済みのユーザーを Admin にする(運用スクリプト)。登録情報は出力から取り出す。 */
export function grantAdmin(email: string): ProvisionedAdmin {
  const output = runAdminCli("grant", email);
  const publicId = /管理者の公開 ID: ([0-9a-f-]{36})/.exec(output)?.[1];
  const secret = /otpauth:\/\/\S*[?&]secret=([A-Z2-7]+)/.exec(output)?.[1];
  const recoveryCodes = [...output.matchAll(/^ {2}(\S+-\S+)$/gm)].map((match) => match[1] ?? "");
  if (publicId === undefined || secret === undefined || recoveryCodes.length === 0) {
    throw new Error("admin:grant の出力から登録情報を取得できませんでした");
  }
  return { publicId, totpSecret: base32Decode(secret), recoveryCodes };
}

export function disableAdmin(email: string): void {
  runAdminCli("disable", email);
}

/** RFC 6238(HMAC-SHA1、30 秒、6 桁)。 */
export function totpCode(secret: Buffer, nowMs: number = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(nowMs / 1000 / 30)));
  const digest = createHmac("sha1", secret).update(counter).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const binary =
    (((digest[offset] ?? 0) & 0x7f) << 24) |
    ((digest[offset + 1] ?? 0) << 16) |
    ((digest[offset + 2] ?? 0) << 8) |
    (digest[offset + 3] ?? 0);
  return String(binary % 1_000_000).padStart(6, "0");
}

/** E2E database への直接の問い合わせ(結果の確認と運用データの投入。認証の迂回には使わない)。 */
async function withDatabase<T>(run: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: E2E_DATABASE_URL });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

export async function userPublicId(email: string): Promise<string> {
  return withDatabase(async (client) => {
    const result = await client.query<{ public_id: string }>(
      "SELECT public_id FROM users WHERE email_normalized = $1",
      [email.toLowerCase()],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error("ユーザーが見つかりません");
    return row.public_id;
  });
}

/** 指定した actor(`admin:<公開 ID>`)の監査 action を古い順に返す。 */
export async function auditActions(actor: string): Promise<string[]> {
  return withDatabase(async (client) => {
    const result = await client.query<{ action: string }>(
      "SELECT action FROM audit_logs WHERE actor = $1 ORDER BY id",
      [actor],
    );
    return result.rows.map((row) => row.action);
  });
}

/** 監査ログのどの列にも `text` を含む行がないこと(email が残っていないことの確認用)。 */
export async function auditRowsContaining(text: string): Promise<number> {
  return withDatabase(async (client) => {
    const result = await client.query<{ count: string }>(
      "SELECT count(*) FROM audit_logs WHERE audit_logs::text ILIKE $1",
      [`%${text}%`],
    );
    return Number(result.rows[0]?.count ?? 0);
  });
}

/** そのユーザーの全 session の MFA 検証を 31 分前にする(30 分の有効期限切れの再現)。 */
export async function expireMfaVerification(email: string): Promise<void> {
  await withDatabase(async (client) => {
    await client.query(
      `UPDATE sessions SET mfa_verified_at = now() - interval '31 minutes'
       WHERE user_id = (SELECT id FROM users WHERE email_normalized = $1)`,
      [email.toLowerCase()],
    );
  });
}

/** 運用画面に表示される「失敗した通知配送」を 1 件投入する(通知設定と配送の行。メール送信は行わない)。 */
export async function seedFailedDelivery(email: string, failureCode: string): Promise<void> {
  await withDatabase(async (client) => {
    const user = await client.query<{ id: string }>(
      "SELECT id FROM users WHERE email_normalized = $1",
      [email.toLowerCase()],
    );
    const userId = user.rows[0]?.id;
    if (userId === undefined) throw new Error("ユーザーが見つかりません");
    const setting = await client.query<{ id: string }>(
      `INSERT INTO notification_settings (user_id, channel, local_time, timezone, enabled)
       VALUES ($1, 'email', '20:00', 'Asia/Tokyo', false) RETURNING id`,
      [userId],
    );
    await client.query(
      `INSERT INTO notification_deliveries
         (notification_setting_id, user_id, local_date, next_attempt_at, deduplication_key,
          scheduled_at, status, attempt_count, failure_code)
       VALUES ($1, $2, '2026-10-09', now(), $3, now(), 'failed', 1, $4)`,
      [setting.rows[0]?.id, userId, `e2e-${userId}-2026-10-09`, failureCode],
    );
  });
}
