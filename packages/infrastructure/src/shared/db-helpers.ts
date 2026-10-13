import type { Prisma } from "../generated/prisma/client";

/** アカウント削除・データエクスポートの repository が共有する DB の補助(docs/plans/account-deletion.md ほか)。 */

const MAX_BIGINT = 9_223_372_036_854_775_807n;

/** user ID(session 由来の十進文字列)を bigint へ。形式不正は「何にも到達できない」扱い。 */
export function parseUserId(userId: string): bigint | null {
  if (!/^[1-9][0-9]*$/.test(userId)) return null;
  const value = BigInt(userId);
  return value <= MAX_BIGINT ? value : null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 公開 ID(UUID)の形式か。形式不正は SQL の cast で例外になるため、query の前に除く。 */
export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

export type Tx = Prisma.TransactionClient;

export interface AuditEntry {
  readonly actor: string;
  readonly action: string;
  readonly targetType: string;
  readonly targetPublicId: string;
  readonly requestId: string;
  readonly ipHash: string;
  readonly now: Date;
}

/** 状態変更と同一 transaction で監査を追記する。内容・メール・パスワードは記録しない。 */
export async function appendAudit(tx: Tx, entry: AuditEntry): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO audit_logs (actor, action, target_type, target_public_id, request_id, ip_hash, created_at)
    VALUES (${entry.actor}, ${entry.action}, ${entry.targetType}, ${entry.targetPublicId}::uuid,
            ${entry.requestId}, ${entry.ipHash}, ${entry.now})`;
}
