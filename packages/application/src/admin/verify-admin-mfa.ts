import {
  ADMIN_MFA_LOCKOUT_MS,
  ADMIN_MFA_MAX_FAILED_ATTEMPTS,
  adminAuditActor,
  isMfaLocked,
  mfaRetryAfterSeconds,
  parseMfaCode,
} from "@habit-app/domain";
import type { AdminAuditAction } from "@habit-app/domain";

import type { Clock } from "../auth";
import type {
  AdminAccountRepositoryPort,
  AdminCryptoPort,
  AdminRequestContext,
  AuditLogPort,
  SessionMfaPort,
} from "./ports";

export interface VerifyAdminMfaDeps {
  readonly adminRepository: AdminAccountRepositoryPort;
  readonly sessionMfa: SessionMfaPort;
  readonly crypto: AdminCryptoPort;
  readonly audit: AuditLogPort;
  readonly now: Clock;
}

export type VerifyAdminMfaResult =
  | { readonly status: "verified" }
  /** コードが無効(形式不正・誤り・再利用・使用済みを区別しない)。 */
  | { readonly status: "invalid" }
  | { readonly status: "locked"; readonly retryAfterSeconds: number }
  /** 有効な管理者ではない(呼び出し側は 404 にする)。 */
  | { readonly status: "not_admin" };

/**
 * 管理者の MFA(TOTP またはリカバリーコード)を検証し、成功したら session の検証時刻を更新する(ADM-003)。
 *
 * - ロック中はコードの正否を調べない(総当たりの手がかりを与えない)。
 * - 失敗は種別を区別せず `invalid`。連続失敗の上限でロックする。
 * - 成功の監査に失敗した場合は session の検証を取り消して例外を投げる(fail closed)。
 * - コード・秘密・email を監査やエラーに含めない。
 */
export async function verifyAdminMfaUseCase(
  deps: VerifyAdminMfaDeps,
  input: {
    readonly actorUserId: string;
    readonly sessionId: string;
    readonly code: unknown;
    readonly context: AdminRequestContext;
  },
): Promise<VerifyAdminMfaResult> {
  const account = await deps.adminRepository.findActiveByUserId(input.actorUserId);
  if (account === null) return { status: "not_admin" };

  const now = deps.now();
  if (isMfaLocked(account.lockedUntil, now)) {
    return { status: "locked", retryAfterSeconds: mfaRetryAfterSeconds(account.lockedUntil, now) };
  }

  const audit = (action: AdminAuditAction) =>
    deps.audit.append({
      actor: adminAuditActor(account.adminPublicId),
      action,
      targetType: "admin_session",
      targetPublicId: null,
      requestId: input.context.requestId,
      ipHash: input.context.ipHash,
      now,
    });

  const parsed = parseMfaCode(input.code);
  let accepted = false;
  let usedRecoveryCode = false;
  if (parsed?.kind === "totp") {
    const step = deps.crypto.verifyTotp({
      userId: account.userId,
      encryptedSecret: account.totpSecretEnc,
      code: parsed.code,
      nowMs: now.getTime(),
      lastStep: account.totpLastStep,
    });
    accepted =
      step !== null &&
      (await deps.adminRepository.recordTotpSuccess({ adminId: account.adminId, step, now }));
  } else if (parsed?.kind === "recovery") {
    accepted = await deps.adminRepository.consumeRecoveryCode({
      adminId: account.adminId,
      codeHash: deps.crypto.hashRecoveryCode(parsed.code),
      now,
    });
    usedRecoveryCode = accepted;
  }

  if (!accepted) {
    const failure = await deps.adminRepository.recordMfaFailure({
      adminId: account.adminId,
      now,
      maxAttempts: ADMIN_MFA_MAX_FAILED_ATTEMPTS,
      lockoutMs: ADMIN_MFA_LOCKOUT_MS,
    });
    await audit("admin.mfa.failed");
    if (failure.locked) {
      await audit("admin.mfa.locked");
      return {
        status: "locked",
        retryAfterSeconds: Math.max(1, mfaRetryAfterSeconds(failure.lockedUntil, now)),
      };
    }
    return { status: "invalid" };
  }

  const marked = await deps.sessionMfa.markVerified({
    sessionId: input.sessionId,
    userId: input.actorUserId,
    now,
  });
  if (!marked) return { status: "invalid" };
  try {
    await audit(usedRecoveryCode ? "admin.mfa.recovery_used" : "admin.mfa.verified");
  } catch (error) {
    await deps.sessionMfa
      .clearVerified({ sessionId: input.sessionId, userId: input.actorUserId })
      .catch(() => undefined);
    throw error;
  }
  return { status: "verified" };
}
