import type { LoginAttemptPort } from "@habit-app/application";
import type { PrismaClient } from "../generated/prisma/client";

/** AUTH-010 既定値(直近15分間に5回失敗で15分間 lockout)。Task6でpackages/configへ外出しする予定。 */
const DEFAULT_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 5;
/** record() のたびに pruneExpired() を実行する確率(opportunistic cleanup、Plan参照)。 */
const DEFAULT_CLEANUP_PROBABILITY = 0.01;

export interface PrismaLoginAttemptRepositoryOptions {
  readonly windowMs?: number;
  readonly maxAttempts?: number;
  readonly cleanupProbability?: number;
}

/**
 * LoginAttemptPort 実装(Plan: PrismaLoginAttemptRepository)。login_attempts テーブルを使う。
 * rate limit 判定への組み込み(fail-open 挙動含む)は各 use case 側(Task6)の責務であり、
 * ここでは単純な記録・判定・retention cleanup のみを提供する。
 */
export function createPrismaLoginAttemptRepository(
  prisma: PrismaClient,
  options: PrismaLoginAttemptRepositoryOptions = {},
): LoginAttemptPort {
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const cleanupProbability = options.cleanupProbability ?? DEFAULT_CLEANUP_PROBABILITY;

  async function pruneExpired(): Promise<void> {
    const threshold = new Date(Date.now() - windowMs);
    await prisma.loginAttempt.deleteMany({ where: { attemptedAt: { lt: threshold } } });
  }

  return {
    async record(purpose, emailNormalized, succeeded) {
      await prisma.loginAttempt.create({
        data: { purpose, emailNormalized, succeeded },
      });
      if (Math.random() < cleanupProbability) {
        await pruneExpired();
      }
    },

    async isBlocked(purpose, emailNormalized) {
      const windowStart = new Date(Date.now() - windowMs);
      const failureCount = await prisma.loginAttempt.count({
        where: {
          purpose,
          emailNormalized,
          succeeded: false,
          attemptedAt: { gt: windowStart },
        },
      });
      return failureCount >= maxAttempts;
    },

    pruneExpired,
  };
}
