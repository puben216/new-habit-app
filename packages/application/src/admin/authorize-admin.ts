import { mfaExpiresAt } from "@habit-app/domain";

import type { Clock } from "../auth";
import type { AdminAccountRepositoryPort, AdminIdentity } from "./ports";

export interface AuthorizeAdminDeps {
  readonly adminRepository: Pick<AdminAccountRepositoryPort, "findActiveByUserId">;
  readonly now: Clock;
}

export type AdminAccess =
  /** 有効な管理者ではない(Member、無効化済み、停止中のユーザー)。呼び出し側は 404 にする。 */
  | { readonly status: "not_admin" }
  /** 有効な管理者だが MFA が未検証または期限切れ。 */
  | { readonly status: "mfa_required"; readonly admin: AdminIdentity }
  | {
      readonly status: "granted";
      readonly admin: AdminIdentity;
      readonly mfaExpiresAt: Date;
    };

/**
 * 管理者の認可(ADM-002)。判定は毎回 DB(`admin_users`)で行い、session や client の状態に
 * 「管理者であること」を持たせない。MFA は session 単位の `mfaVerifiedAt` が 30 分未満のときだけ有効。
 */
export async function authorizeAdmin(
  deps: AuthorizeAdminDeps,
  input: { readonly actorUserId: string; readonly mfaVerifiedAt: Date | null },
): Promise<AdminAccess> {
  const account = await deps.adminRepository.findActiveByUserId(input.actorUserId);
  if (account === null) return { status: "not_admin" };

  const admin: AdminIdentity = { adminId: account.adminId, adminPublicId: account.adminPublicId };
  const now = deps.now();
  // 有効期限が求まるのは、検証済みで期限内(かつ未来時刻でない)のときだけ(判定は Domain の isMfaFresh)。
  const expiresAt = mfaExpiresAt(input.mfaVerifiedAt, now);
  if (expiresAt === null) return { status: "mfa_required", admin };
  return { status: "granted", admin, mfaExpiresAt: expiresAt };
}
