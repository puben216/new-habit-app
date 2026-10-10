/**
 * 管理操作の監査 action(ADM-INV-004)。閲覧・認証の記録に使い、検索 query や email は含めない。
 * `operator.*` は運用スクリプトによる Admin の付与・無効化・MFA 再発行。
 */
export const ADMIN_AUDIT_ACTIONS = [
  "admin.mfa.verified",
  "admin.mfa.failed",
  "admin.mfa.locked",
  "admin.mfa.recovery_used",
  "admin.user.search",
  "admin.user.view",
  "admin.notifications.list",
  "admin.ai_jobs.list",
  "operator.admin.granted",
  "operator.admin.disabled",
  "operator.admin.mfa_reset",
] as const;

export type AdminAuditAction = (typeof ADMIN_AUDIT_ACTIONS)[number];

/** 監査ログの actor 表現。Admin は公開 ID、運用スクリプトは固定文字列(個人情報を含めない)。 */
export function adminAuditActor(adminPublicId: string): string {
  return `admin:${adminPublicId}`;
}

export const OPERATOR_AUDIT_ACTOR = "operator";
