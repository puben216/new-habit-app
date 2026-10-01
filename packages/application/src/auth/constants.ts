/**
 * email verification token の有効期限(MVP既定値)。
 * docs/specs/auth-adapter.md / docs/plans/auth-adapter.md は具体的な有効期限を規定していないため、
 * 一般的なメール確認リンクの慣行に合わせた運用上のデフォルトとする(調整が必要になれば設定値化する)。
 */
export const VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/** password reset token の有効期限(MVP既定値)。verification token より機微度が高いため短くする。 */
export const PASSWORD_RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

/**
 * session の有効期限(MVP既定値、docs/plans/auth-adapter.md 2026-09-22改訂)。
 * Auth.js の session maxAge 既定値(30日)に合わせる。Infrastructure の authOptions が
 * session 作成(AuthRepositoryPort.createSession)と Auth.js 自身の JWT maxAge の両方に使う。
 */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
