import { ACCOUNT_PURGE_BATCH_SIZE, deletionDeadline, purgeCutoff } from "@habit-app/domain";

import type { Clock, LoginAttemptPort, PasswordHasherPort } from "../auth";
import {
  AccountNotActiveError,
  AccountNotFoundError,
  DeletionAlreadyRequestedError,
  DeletionNotRequestedError,
  GracePeriodExpiredError,
  ReauthenticationFailedError,
  TooManyAttemptsError,
} from "./errors";
import type {
  AccountRepositoryPort,
  AccountRequestContext,
  ExternalDataCleanupPort,
} from "./ports";

/**
 * アカウント削除の use case(docs/specs/account-deletion.md)。
 * 期限の計算は Domain の関数だけが行い、ここでは再実装しない(ACD-INV-001)。
 */

export interface RequestAccountDeletionDeps {
  readonly accounts: AccountRepositoryPort;
  readonly passwordHasher: PasswordHasherPort;
  /** 再認証の試行制限(`purpose = 'reauth'`)。 */
  readonly attempts: LoginAttemptPort;
  readonly now: Clock;
}

export interface AccountDeletionRequested {
  readonly status: "deletion_pending";
  /** 猶予期間の終了時刻(この時刻以降は取り消せず、削除ジョブの対象になる)。 */
  readonly scheduledFor: Date;
}

/**
 * 再認証(パスワード)のうえ、削除を予約する(ACD-001/002)。
 * 制限中は、パスワードが正しくても検証しない(総当たりの手がかりを与えない)。
 *
 * @throws {AccountNotFoundError} actor の user が存在しない
 * @throws {AccountNotActiveError} active ではない
 * @throws {DeletionAlreadyRequestedError} 既に削除予約中(並行要求を含む)
 * @throws {TooManyAttemptsError} 再認証の失敗が上限に達している
 * @throws {ReauthenticationFailedError} パスワードが一致しない
 */
export async function requestAccountDeletionUseCase(
  deps: RequestAccountDeletionDeps,
  input: {
    readonly actorUserId: string;
    readonly password: string;
    readonly context: AccountRequestContext;
  },
): Promise<AccountDeletionRequested> {
  const account = await deps.accounts.findForReauth(input.actorUserId);
  if (account === null) throw new AccountNotFoundError();
  if (account.status === "deletion_pending") throw new DeletionAlreadyRequestedError();
  if (account.status !== "active") throw new AccountNotActiveError();

  if (await deps.attempts.isBlocked("reauth", account.emailNormalized)) {
    throw new TooManyAttemptsError();
  }
  const matched = await deps.passwordHasher.verify(input.password, account.passwordHash);
  await deps.attempts.record("reauth", account.emailNormalized, matched);
  if (!matched) throw new ReauthenticationFailedError();

  const now = deps.now();
  const result = await deps.accounts.requestDeletion({
    userId: input.actorUserId,
    now,
    context: input.context,
  });
  switch (result) {
    case "requested":
      return { status: "deletion_pending", scheduledFor: deletionDeadline(now) };
    case "already_requested":
      throw new DeletionAlreadyRequestedError();
    case "not_active":
      throw new AccountNotActiveError();
    case "not_found":
      throw new AccountNotFoundError();
    default: {
      const unreachable: never = result;
      return unreachable;
    }
  }
}

export interface CancelAccountDeletionDeps {
  readonly accounts: AccountRepositoryPort;
  readonly now: Clock;
}

/**
 * 猶予期間内の削除予約を取り消す(ACD-004)。
 *
 * @throws {AccountNotFoundError} actor の user が存在しない
 * @throws {DeletionNotRequestedError} 削除予約中ではない
 * @throws {GracePeriodExpiredError} 猶予期間が終わっている(削除ジョブの未実行を含む)
 */
export async function cancelAccountDeletionUseCase(
  deps: CancelAccountDeletionDeps,
  input: { readonly actorUserId: string; readonly context: AccountRequestContext },
): Promise<{ readonly status: "active" }> {
  const now = deps.now();
  const result = await deps.accounts.cancelDeletion({
    userId: input.actorUserId,
    now,
    cutoff: purgeCutoff(now),
    context: input.context,
  });
  switch (result) {
    case "cancelled":
      return { status: "active" };
    case "not_requested":
      throw new DeletionNotRequestedError();
    case "expired":
      throw new GracePeriodExpiredError();
    case "not_found":
      throw new AccountNotFoundError();
    default: {
      const unreachable: never = result;
      return unreachable;
    }
  }
}

export type AccountDeletionStatus =
  | { readonly status: "active"; readonly scheduledFor: null }
  | { readonly status: "deletion_pending"; readonly scheduledFor: Date };

/** 削除予約の状態を返す(ACD-005)。停止中など active 以外で削除予約でないものは `active` として返す。 */
export async function getAccountDeletionStatusUseCase(
  deps: { readonly accounts: AccountRepositoryPort },
  input: { readonly actorUserId: string },
): Promise<AccountDeletionStatus> {
  const state = await deps.accounts.findDeletionState(input.actorUserId);
  if (state === null) throw new AccountNotFoundError();
  if (state.status === "deletion_pending" && state.deletedAt !== null) {
    return { status: "deletion_pending", scheduledFor: deletionDeadline(state.deletedAt) };
  }
  return { status: "active", scheduledFor: null };
}

export interface PurgeExpiredAccountsDeps {
  readonly accounts: AccountRepositoryPort;
  readonly cleanup: ExternalDataCleanupPort;
  readonly now: Clock;
  /** 1 回の実行を識別する値(監査の request ID)。 */
  readonly newRequestId: () => string;
}

export interface PurgeSummary {
  readonly purged: number;
  readonly failed: number;
  readonly skipped: number;
}

/**
 * 猶予期間が終わったアカウントを削除する(ACD-006)。1 件ずつ独立に処理し、1 件の失敗が他に影響しない。
 * 外部データの片付けが失敗したユーザーは削除せず、次回の実行で再試行する。戻り値は件数のみ。
 */
export async function purgeExpiredAccountsUseCase(
  deps: PurgeExpiredAccountsDeps,
): Promise<PurgeSummary> {
  const now = deps.now();
  const cutoff = purgeCutoff(now);
  const targets = await deps.accounts.findDueForPurge({
    cutoff,
    limit: ACCOUNT_PURGE_BATCH_SIZE,
  });

  let purged = 0;
  let failed = 0;
  let skipped = 0;
  for (const target of targets) {
    try {
      await deps.cleanup.cleanup(target);
      const result = await deps.accounts.purge({
        userId: target.userId,
        cutoff,
        now,
        requestId: deps.newRequestId(),
      });
      if (result === "purged") purged += 1;
      else skipped += 1;
    } catch {
      // 例外の内容(識別子や SQL を含みうる)は残さない。件数だけを返す。
      failed += 1;
    }
  }
  return { purged, failed, skipped };
}
