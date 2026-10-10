import { ADMIN_RECOVERY_CODE_COUNT, OPERATOR_AUDIT_ACTOR, normalizeEmail } from "@habit-app/domain";
import type { AdminAuditAction } from "@habit-app/domain";

import type { Clock } from "../auth";
import type { AdminCryptoPort, AdminProvisioningPort, AuditLogPort } from "./ports";

/**
 * 管理者の付与・無効化・MFA 再発行(ADM-001)。運用スクリプトだけが呼ぶ(Web/API に経路を作らない)。
 * 結果は監査ログに残す(actor は `operator`)。対象ユーザーの email を戻り値・監査・エラーに含めない。
 */

export interface ProvisionAdminDeps {
  readonly provisioning: AdminProvisioningPort;
  readonly crypto: AdminCryptoPort;
  readonly audit: AuditLogPort;
  readonly now: Clock;
  /** 監査の request ID(スクリプトの実行ごとに 1 つ)。 */
  readonly requestId: string;
}

/** 認証アプリへの登録に一度だけ表示する秘密。DB・ログ・監査には残さない。 */
export interface AdminEnrollmentSecrets {
  readonly adminPublicId: string;
  readonly otpauthUri: string;
  readonly recoveryCodes: readonly string[];
}

export type GrantAdminResult =
  | ({ readonly status: "granted" } & AdminEnrollmentSecrets)
  | { readonly status: "user_not_eligible" }
  | { readonly status: "already_active" };

async function recordOperatorAudit(
  deps: ProvisionAdminDeps,
  action: AdminAuditAction,
  adminPublicId: string,
): Promise<void> {
  await deps.audit.append({
    actor: OPERATOR_AUDIT_ACTOR,
    action,
    targetType: "admin",
    targetPublicId: adminPublicId,
    requestId: deps.requestId,
    ipHash: "cli",
    now: deps.now(),
  });
}

/** email 確認済みの既存ユーザーを管理者にする。無効化済みの管理者は再有効化して MFA を作り直す。 */
export async function grantAdminUseCase(
  deps: ProvisionAdminDeps,
  input: { readonly email: string },
): Promise<GrantAdminResult> {
  const user = await deps.provisioning.findEligibleUserByEmail(normalizeEmail(input.email));
  if (user === null) return { status: "user_not_eligible" };

  const recovery = deps.crypto.generateRecoveryCodes(ADMIN_RECOVERY_CODE_COUNT);
  const enrollment = deps.crypto.enrollTotp({ userId: user.userId, accountLabel: "admin" });
  const granted = await deps.provisioning.grant({
    userId: user.userId,
    totpSecretEnc: enrollment.encryptedSecret,
    recoveryCodeHashes: recovery.hashes,
  });
  if (granted.status === "already_active") return { status: "already_active" };

  await recordOperatorAudit(deps, "operator.admin.granted", granted.adminPublicId);
  return {
    status: "granted",
    adminPublicId: granted.adminPublicId,
    otpauthUri: enrollment.otpauthUri,
    recoveryCodes: recovery.codes,
  };
}

export type DisableAdminResult =
  | { readonly status: "disabled"; readonly adminPublicId: string }
  | { readonly status: "not_found" };

export async function disableAdminUseCase(
  deps: ProvisionAdminDeps,
  input: { readonly email: string },
): Promise<DisableAdminResult> {
  const user = await deps.provisioning.findEligibleUserByEmail(normalizeEmail(input.email));
  if (user === null) return { status: "not_found" };
  const disabled = await deps.provisioning.disable({ userId: user.userId });
  if (disabled === null) return { status: "not_found" };

  await recordOperatorAudit(deps, "operator.admin.disabled", disabled.adminPublicId);
  return { status: "disabled", adminPublicId: disabled.adminPublicId };
}

export type ResetAdminMfaResult =
  ({ readonly status: "reset" } & AdminEnrollmentSecrets) | { readonly status: "not_found" };

/** 有効な管理者の TOTP 秘密とリカバリーコードを作り直し、全 session の MFA 検証を無効にする。 */
export async function resetAdminMfaUseCase(
  deps: ProvisionAdminDeps,
  input: { readonly email: string },
): Promise<ResetAdminMfaResult> {
  const user = await deps.provisioning.findEligibleUserByEmail(normalizeEmail(input.email));
  if (user === null) return { status: "not_found" };

  const recovery = deps.crypto.generateRecoveryCodes(ADMIN_RECOVERY_CODE_COUNT);
  const enrollment = deps.crypto.enrollTotp({ userId: user.userId, accountLabel: "admin" });
  const reset = await deps.provisioning.resetMfa({
    userId: user.userId,
    totpSecretEnc: enrollment.encryptedSecret,
    recoveryCodeHashes: recovery.hashes,
  });
  if (reset === null) return { status: "not_found" };

  await recordOperatorAudit(deps, "operator.admin.mfa_reset", reset.adminPublicId);
  return {
    status: "reset",
    adminPublicId: reset.adminPublicId,
    otpauthUri: enrollment.otpauthUri,
    recoveryCodes: recovery.codes,
  };
}
