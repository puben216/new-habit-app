import { spawnSync } from "node:child_process";

import pg from "pg";

import { E2E_ADMIN_DATABASE_URL, E2E_DATABASE_NAME, E2E_DATABASE_URL } from "../support/e2e-env.ts";

/**
 * E2E 専用 database を作り直して Migration を適用する(WUI-008、WUI-INV-007)。
 * 開発用 database(`habit_app_dev`)には触れない。database 名は固定の定数で、外部入力を使わない。
 */
async function recreateDatabase(): Promise<void> {
  const client = new pg.Client({ connectionString: E2E_ADMIN_DATABASE_URL });
  await client.connect();
  try {
    await client.query(`DROP DATABASE IF EXISTS ${E2E_DATABASE_NAME} WITH (FORCE)`);
    await client.query(`CREATE DATABASE ${E2E_DATABASE_NAME}`);
  } finally {
    await client.end();
  }
}

function applyMigrations(): void {
  const result = spawnSync(
    "pnpm",
    ["--filter", "@habit-app/infrastructure", "run", "migrate:deploy"],
    {
      stdio: "inherit",
      env: { ...process.env, DATABASE_URL: E2E_DATABASE_URL },
    },
  );
  if (result.status !== 0) {
    throw new Error("E2E database への migration 適用に失敗しました");
  }
}

try {
  await recreateDatabase();
  applyMigrations();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`E2E database の準備に失敗しました: ${message}`);
  console.error("Docker Compose の postgres が起動しているか確認してください(pnpm db:up)。");
  process.exit(1);
}
