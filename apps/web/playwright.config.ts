import { defineConfig, devices } from "@playwright/test";

import { E2E_BASE_URL, E2E_PORT, e2eAppEnv } from "./e2e/support/e2e-env";

/**
 * Playwright 設定(ADR-010、docs/specs/web-ui-foundation.md WUI-008)。
 * 起動時に E2E 専用 database を作り直し、ビルド済みアプリ(`next start`)に対して実行する。
 * `NODE_ENV=test` で起動するのは、`next start` の既定の `production` では
 * `AUTH_EMAIL_SENDER=smtp`(Mailpit)が `parseEnv` に拒否されるため。
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: true,
  forbidOnly: process.env["CI"] !== undefined,
  retries: 0,
  reporter: process.env["CI"] === undefined ? [["list"]] : [["list"], ["github"]],
  use: {
    baseURL: E2E_BASE_URL,
    // 失敗時のみ保持する(fixture は架空データのみ)。
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `node e2e/scripts/prepare-database.ts && next build && NODE_ENV=test next start -p ${E2E_PORT}`,
    url: E2E_BASE_URL,
    reuseExistingServer: false,
    timeout: 300_000,
    env: e2eAppEnv(),
    stdout: "pipe",
    stderr: "pipe",
  },
});
