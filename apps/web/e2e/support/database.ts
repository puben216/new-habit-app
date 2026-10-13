import pg from "pg";

import { E2E_DATABASE_URL } from "./e2e-env";

/** E2E database への直接の問い合わせ(結果の確認と運用データの投入。認証の迂回には使わない)。 */
export async function withDatabase<T>(run: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: E2E_DATABASE_URL });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}
