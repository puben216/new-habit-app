/**
 * E2E の接続先と環境変数(ADR-010、docs/specs/web-ui-foundation.md WUI-008)。
 *
 * ここにある値はローカル/CI 専用の公開してよいダミーで、実在の Secret ではない
 * (`AUTH_SECRET` は E2E のアプリ起動専用の固定値。本番・開発用の値とは無関係)。
 * 接続先はローカルの Docker Compose(`postgres`、`mailpit`)であり、開発用 database には触れない。
 */
export const E2E_PORT = 3100;
export const E2E_BASE_URL = `http://localhost:${E2E_PORT}`;

export const E2E_DATABASE_NAME = "habit_app_e2e";
// ローカルの 5432 が他のプロジェクトに使われている場合は E2E_POSTGRES_PORT で変更できる(docker-compose.yml の POSTGRES_PORT と揃える)。
const DATABASE_PORT = process.env["E2E_POSTGRES_PORT"] ?? "5432";
const DATABASE_ORIGIN = `postgresql://habit_app:habit_app@localhost:${DATABASE_PORT}`;
export const E2E_ADMIN_DATABASE_URL = `${DATABASE_ORIGIN}/postgres`;
export const E2E_DATABASE_URL = `${DATABASE_ORIGIN}/${E2E_DATABASE_NAME}`;

export const E2E_MAILPIT_HTTP_URL = "http://localhost:8025";
export const E2E_SMTP_HOST = "localhost";
export const E2E_SMTP_PORT = "1025";

export const E2E_AUTH_SECRET = "e2e-only-dummy-secret-not-for-real-use-0123456789";

// 管理機能(T-403)用のダミー鍵。32 バイトの固定値(base64)と 32 文字以上の HMAC 鍵で、実在の Secret ではない。
export const E2E_ADMIN_TOTP_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
export const E2E_AUDIT_IP_HASH_KEY = "e2e-only-dummy-audit-ip-hash-key-0123456789";

/** アプリ(`next build`/`next start`)に渡す env。`NODE_ENV` は起動コマンド側で指定する。 */
export function e2eAppEnv(): Record<string, string> {
  return {
    DATABASE_URL: E2E_DATABASE_URL,
    AUTH_SECRET: E2E_AUTH_SECRET,
    AUTH_TRUST_HOST: "true",
    AUTH_EMAIL_SENDER: "smtp",
    SMTP_HOST: E2E_SMTP_HOST,
    SMTP_PORT: E2E_SMTP_PORT,
    EMAIL_FROM: "no-reply@habit-app.local",
    APP_BASE_URL: E2E_BASE_URL,
    ADMIN_TOTP_ENCRYPTION_KEY: E2E_ADMIN_TOTP_ENCRYPTION_KEY,
    AUDIT_IP_HASH_KEY: E2E_AUDIT_IP_HASH_KEY,
  };
}
