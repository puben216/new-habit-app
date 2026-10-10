/**
 * 管理機能の方針と純粋な判定(docs/specs/minimal-admin.md)。
 * 定数は暫定値(ADM-INV-009)。確定・調整時はここだけを変更する。
 */

/** MFA 検証の有効期間。検証時刻からの絶対期限で、アクセスで延長しない(ADM-INV-003)。 */
export const ADMIN_MFA_TTL_MS = 30 * 60_000;
/** この回数の連続失敗でロックする。 */
export const ADMIN_MFA_MAX_FAILED_ATTEMPTS = 5;
/** ロック時間(ミリ秒)。 */
export const ADMIN_MFA_LOCKOUT_MS = 15 * 60_000;
/** 発行するリカバリーコードの数。 */
export const ADMIN_RECOVERY_CODE_COUNT = 8;
/** 一覧のページサイズ上限と既定値。 */
export const ADMIN_PAGE_SIZE_MAX = 50;
export const ADMIN_PAGE_SIZE_DEFAULT = 20;
/** 概要で集計する期間(日)。 */
export const ADMIN_OVERVIEW_WINDOW_DAYS = 30;

/**
 * MFA の検証が有効か。`verifiedAt` から TTL 未満で、未来の時刻でないときだけ有効。
 * 未検証(null)、ちょうど TTL、TTL 超過、未来時刻(時計のずれ・改ざん)は無効。
 */
export function isMfaFresh(verifiedAt: Date | null, now: Date): boolean {
  if (verifiedAt === null) return false;
  const elapsed = now.getTime() - verifiedAt.getTime();
  return elapsed >= 0 && elapsed < ADMIN_MFA_TTL_MS;
}

/** MFA の有効期限(検証済みでなければ null)。 */
export function mfaExpiresAt(verifiedAt: Date | null, now: Date): Date | null {
  return isMfaFresh(verifiedAt, now)
    ? new Date((verifiedAt as Date).getTime() + ADMIN_MFA_TTL_MS)
    : null;
}

/** ロック中か(`lockedUntil` を過ぎていればロックは解けている)。 */
export function isMfaLocked(lockedUntil: Date | null, now: Date): boolean {
  return lockedUntil !== null && lockedUntil.getTime() > now.getTime();
}

/** ロックの残り秒数(切り上げ)。ロック中でなければ 0。 */
export function mfaRetryAfterSeconds(lockedUntil: Date | null, now: Date): number {
  if (!isMfaLocked(lockedUntil, now)) return 0;
  return Math.ceil(((lockedUntil as Date).getTime() - now.getTime()) / 1000);
}
