import type { AccountStatus } from "@habit-app/domain";

/**
 * アカウント削除の port(docs/plans/account-deletion.md)。
 * 状態の変更は条件付き更新の単一文で行い、監査の追記と同一 transaction にする(ACD-INV-002/006/007)。
 */

/** 監査ログに残す要求の文脈。生の IP は渡さず、不可逆化した値だけを渡す。 */
export interface AccountRequestContext {
  readonly requestId: string;
  readonly ipHash: string;
}

/** 再認証に必要な情報。`passwordHash` は検証にのみ使い、外へ返さない。 */
export interface ReauthRecord {
  readonly emailNormalized: string;
  readonly passwordHash: string;
  readonly status: AccountStatus;
}

export type RequestDeletionResult = "requested" | "already_requested" | "not_active" | "not_found";
export type CancelDeletionResult = "cancelled" | "not_requested" | "expired" | "not_found";
export type PurgeResult = "purged" | "skipped";

export interface DeletionState {
  readonly status: AccountStatus;
  readonly deletedAt: Date | null;
}

export interface PurgeTarget {
  readonly userId: string;
  /** 外部データの片付けと監査の対象。内部 ID ではなく公開 ID。 */
  readonly userPublicId: string;
}

export interface AccountRepositoryPort {
  /** 再認証用の情報。user が存在しなければ `null`。 */
  findForReauth(userId: string): Promise<ReauthRecord | null>;

  /**
   * `status = 'active'` のユーザーを削除予約にする(`deleted_at = now`)。同一 transaction で、
   * そのユーザーの全 session を削除し、監査(`user.account.deletion_requested`)を追記する。
   */
  requestDeletion(input: {
    readonly userId: string;
    readonly now: Date;
    readonly context: AccountRequestContext;
  }): Promise<RequestDeletionResult>;

  /**
   * 削除予約中で、猶予期間内(`deleted_at > cutoff`)のユーザーを active に戻す。同一 transaction で
   * 監査(`user.account.deletion_cancelled`)を追記する。失敗の理由は結果で区別する。
   */
  cancelDeletion(input: {
    readonly userId: string;
    readonly now: Date;
    /** `purgeCutoff(now)`。`deleted_at <= cutoff` は猶予期間の終了。 */
    readonly cutoff: Date;
    readonly context: AccountRequestContext;
  }): Promise<CancelDeletionResult>;

  findDeletionState(userId: string): Promise<DeletionState | null>;

  /** 猶予期間が終わった(`deleted_at <= cutoff`)削除予約中のユーザーを古い順に返す。 */
  findDueForPurge(input: {
    readonly cutoff: Date;
    readonly limit: number;
  }): Promise<readonly PurgeTarget[]>;

  /**
   * 対象の行をロックし、条件(`status = 'deletion_pending' AND deleted_at <= cutoff`)を再確認したうえで、
   * 監査(`system.account.purged`)の追記と `users` の削除(子データは `ON DELETE CASCADE`)を
   * 同一 transaction で行う。条件を満たさなければ何もせず `skipped`。
   */
  purge(input: {
    readonly userId: string;
    readonly cutoff: Date;
    readonly now: Date;
    readonly requestId: string;
  }): Promise<PurgeResult>;
}

/**
 * AI provider・メール provider など、DB の外にある個人データの片付け(ACD-006)。
 * provider が未確定のため、現時点の実装は何もしない。実装する際は冪等にし、失敗は例外にする
 * (削除ジョブはそのユーザーを削除せず、次回に再試行する)。
 */
export interface ExternalDataCleanupPort {
  cleanup(target: PurgeTarget): Promise<void>;
}
