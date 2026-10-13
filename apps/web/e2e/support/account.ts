import { spawnSync } from "node:child_process";
import path from "node:path";

import { withDatabase } from "./database";
import { E2E_DATABASE_URL } from "./e2e-env";

/** アカウント削除(T-404)の E2E 支援。ここにある値はローカル/CI 専用の使い捨てで、実在の Secret ではない。 */

// Playwright は apps/web で実行される(`pnpm --filter web test:e2e`)。リポジトリのルートはその 2 つ上。
const REPO_ROOT = path.resolve(process.cwd(), "../..");

/** 削除予約の要求時刻を `days` 日さかのぼらせる(猶予期間の経過の再現)。 */
export async function ageDeletionRequest(email: string, days: number): Promise<void> {
  await withDatabase(async (client) => {
    await client.query(
      `UPDATE users SET deleted_at = deleted_at - make_interval(days => $2::int)
       WHERE email_normalized = $1 AND status = 'deletion_pending'`,
      [email.toLowerCase(), days],
    );
  });
}

export async function userRowExists(email: string): Promise<boolean> {
  return withDatabase(async (client) => {
    const result = await client.query("SELECT 1 FROM users WHERE email_normalized = $1", [
      email.toLowerCase(),
    ]);
    return result.rowCount === 1;
  });
}

export async function accountStatusOf(email: string): Promise<string | null> {
  return withDatabase(async (client) => {
    const result = await client.query<{ status: string }>(
      "SELECT status FROM users WHERE email_normalized = $1",
      [email.toLowerCase()],
    );
    return result.rows[0]?.status ?? null;
  });
}

/** 対象ユーザー(公開 ID)に関する監査 action を古い順に返す。 */
export async function auditActionsForTarget(publicId: string): Promise<string[]> {
  return withDatabase(async (client) => {
    const result = await client.query<{ action: string }>(
      "SELECT action FROM audit_logs WHERE target_public_id = $1 ORDER BY id",
      [publicId],
    );
    return result.rows.map((row) => row.action);
  });
}

/** 本物の削除ジョブ(`pnpm account:purge`)を E2E database に対して実行し、件数の出力を返す。 */
export function runPurgeJob(): { purged: number; failed: number; skipped: number } {
  const result = spawnSync("pnpm", ["account:purge"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      DATABASE_URL: E2E_DATABASE_URL,
      ACCOUNT_PURGE_ENABLED: "true",
      AWS_REGION: "ap-northeast-1",
    },
  });
  if (result.status !== 0) {
    throw new Error(`pnpm account:purge が失敗しました(終了コード ${String(result.status)})`);
  }
  const line = result.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{") && l.includes('"purged"'))
    .pop();
  if (line === undefined) throw new Error("account:purge の出力を取得できませんでした");
  return JSON.parse(line) as { purged: number; failed: number; skipped: number };
}
