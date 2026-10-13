import {
  DATA_EXPORT_CLEANUP_BATCH_SIZE,
  DATA_EXPORT_DAILY_LIMIT,
  DATA_EXPORT_LEASE_SECONDS,
  DATA_EXPORT_LIST_LIMIT,
  DATA_EXPORT_MAX_BYTES,
  DATA_EXPORT_MAX_RECEIVE,
  buildExportCsvZip,
  buildExportJson,
  exportExpiresAt,
  exportFileInfo,
  exportRateWindowStart,
  exportRetentionCutoff,
  exportStaleCutoff,
  isExportExpired,
} from "@habit-app/domain";
import type { DataExportFormat, DataExportStatus } from "@habit-app/domain";

import { AccountNotActiveError, AccountNotFoundError, verifyReauthentication } from "../account";
import type { AccountRepositoryPort, AccountRequestContext } from "../account";
import type { Clock, LoginAttemptPort, PasswordHasherPort } from "../auth";
import {
  ExportExpiredError,
  ExportInProgressError,
  ExportNotFoundError,
  ExportNotReadyError,
  ExportRateLimitedError,
  ExportUnavailableError,
} from "./errors";
import type {
  DataExportQueuePort,
  DataExportRecord,
  DataExportRepositoryPort,
  ExportDataSourcePort,
} from "./ports";

/**
 * データエクスポートの use case(docs/specs/data-export.md)。
 * 期限・頻度・形式・上限の定義は Domain の関数・定数だけが持ち、ここでは再実装しない。
 */

/** 期限を過ぎた `ready` は、定期ジョブが `expired` にするまでの間も `expired` として扱う(EXP-003)。 */
export function effectiveExportStatus(record: DataExportRecord, now: Date): DataExportStatus {
  return record.status === "ready" &&
    record.expiresAt !== null &&
    isExportExpired(record.expiresAt, now)
    ? "expired"
    : record.status;
}

export interface RequestDataExportDeps {
  readonly accounts: AccountRepositoryPort;
  readonly exports: DataExportRepositoryPort;
  readonly queue: DataExportQueuePort;
  readonly passwordHasher: PasswordHasherPort;
  /** 再認証の試行制限(`purpose = 'reauth'`。アカウント削除と共有)。 */
  readonly attempts: LoginAttemptPort;
  readonly now: Clock;
}

/**
 * 再認証(パスワード)のうえ、エクスポートを `queued` で作成して queue に投入する(EXP-001)。
 * 投入に失敗した場合は、作成した行を `failed(enqueue_failed)` にする。
 *
 * @throws {AccountNotFoundError} actor の user が存在しない
 * @throws {AccountNotActiveError} active ではない
 * @throws {TooManyAttemptsError} 再認証の失敗が上限に達している
 * @throws {ReauthenticationFailedError} パスワードが一致しない
 * @throws {ExportInProgressError} `queued`/`running` のエクスポートが既にある
 * @throws {ExportRateLimitedError} 直近 24 時間の作成件数が上限
 * @throws {ExportUnavailableError} queue への投入に失敗した
 */
export async function requestDataExportUseCase(
  deps: RequestDataExportDeps,
  input: {
    readonly actorUserId: string;
    readonly password: string;
    readonly format: DataExportFormat;
    readonly context: AccountRequestContext;
  },
): Promise<DataExportRecord> {
  const account = await deps.accounts.findForReauth(input.actorUserId);
  if (account === null) throw new AccountNotFoundError();
  if (account.status !== "active") throw new AccountNotActiveError();
  await verifyReauthentication(deps, account, input.password);

  const now = deps.now();
  const created = await deps.exports.createIfAllowed({
    actorUserId: input.actorUserId,
    format: input.format,
    now,
    windowStart: exportRateWindowStart(now),
    dailyLimit: DATA_EXPORT_DAILY_LIMIT,
    staleBefore: exportStaleCutoff(now),
    context: input.context,
  });
  switch (created.status) {
    case "in_progress":
      throw new ExportInProgressError();
    case "rate_limited":
      throw new ExportRateLimitedError();
    case "not_found":
      throw new AccountNotFoundError();
    case "created":
      break;
    default: {
      const unreachable: never = created;
      return unreachable;
    }
  }

  try {
    await deps.queue.enqueue({ version: 1, exportId: created.export.id });
  } catch {
    await deps.exports.fail({ exportId: created.export.id, failureCode: "enqueue_failed" });
    throw new ExportUnavailableError();
  }
  return created.export;
}

/** 自分の直近のエクスポートを新しい順に返す(EXP-003)。状態は期限を考慮した表示用のもの。 */
export async function listDataExportsUseCase(
  deps: { readonly exports: DataExportRepositoryPort; readonly now: Clock },
  input: { readonly actorUserId: string },
): Promise<readonly DataExportRecord[]> {
  const records = await deps.exports.list({
    actorUserId: input.actorUserId,
    limit: DATA_EXPORT_LIST_LIMIT,
  });
  const now = deps.now();
  return records.map((record) => ({ ...record, status: effectiveExportStatus(record, now) }));
}

export interface DataExportDownload {
  readonly fileName: string;
  readonly contentType: string;
  readonly content: Uint8Array;
}

/**
 * 自分の完成済み・期限内のエクスポートを返す(EXP-004)。監査の追記が先で、失敗したら読まない。
 *
 * @throws {ExportNotFoundError} 存在しない、または自分のものではない(区別しない)
 * @throws {ExportNotReadyError} 完成していない、または失敗した
 * @throws {ExportExpiredError} 期限を過ぎている
 */
export async function downloadDataExportUseCase(
  deps: { readonly exports: DataExportRepositoryPort; readonly now: Clock },
  input: {
    readonly actorUserId: string;
    readonly exportId: string;
    readonly context: AccountRequestContext;
  },
): Promise<DataExportDownload> {
  const result = await deps.exports.readArtifact({
    actorUserId: input.actorUserId,
    exportId: input.exportId,
    now: deps.now(),
    context: input.context,
  });
  switch (result.status) {
    case "ok": {
      const { fileName, contentType } = result.export;
      // 完成済みの行は、ファイル名・Content-Type が必ず設定されている(DB の CHECK)。
      if (fileName === null || contentType === null) throw new ExportNotReadyError();
      return { fileName, contentType, content: result.content };
    }
    case "not_found":
      throw new ExportNotFoundError();
    case "not_ready":
      throw new ExportNotReadyError();
    case "expired":
      throw new ExportExpiredError();
    default: {
      const unreachable: never = result;
      return unreachable;
    }
  }
}

export interface ProcessDataExportDeps {
  readonly exports: DataExportRepositoryPort;
  readonly dataSource: ExportDataSourcePort;
  readonly now: Clock;
}

export type ProcessDataExportOutcome = "done" | "retry";

/**
 * worker の本体(EXP-002)。重複配送でも確定は 1 回で、終端の job は何もしない。
 * 収集の失敗(DB の一時的な障害など)は受信回数の上限まで再配送し、生成の失敗は再試行しても直らないため
 * 即座に `failed(generation_failed)`。上限(20 MiB)を超えたら `failed(too_large)`で何も保存しない。
 * 失敗の理由はコードのみを残し、データの内容・例外メッセージを残さない。
 */
export async function processDataExportUseCase(
  deps: ProcessDataExportDeps,
  input: { readonly exportId: string; readonly receiveCount: number },
): Promise<ProcessDataExportOutcome> {
  const claimed = await deps.exports.claim({
    exportId: input.exportId,
    leaseSeconds: DATA_EXPORT_LEASE_SECONDS,
  });
  if (claimed.status === "not_found" || claimed.status === "finished") return "done";
  if (claimed.status === "in_progress") return "retry";
  const job = claimed.export;

  let bundle;
  try {
    bundle = await deps.dataSource.collect({ userId: job.userId });
  } catch {
    if (input.receiveCount >= DATA_EXPORT_MAX_RECEIVE) {
      await deps.exports.fail({ exportId: input.exportId, failureCode: "worker_error" });
      return "done";
    }
    await deps.exports.release({ exportId: input.exportId });
    return "retry";
  }

  const completedAt = deps.now();
  let content: Uint8Array;
  try {
    content =
      job.format === "json"
        ? buildExportJson(bundle, completedAt)
        : buildExportCsvZip(bundle, completedAt);
  } catch {
    await deps.exports.fail({ exportId: input.exportId, failureCode: "generation_failed" });
    return "done";
  }
  if (content.length > DATA_EXPORT_MAX_BYTES) {
    await deps.exports.fail({ exportId: input.exportId, failureCode: "too_large" });
    return "done";
  }

  const { fileName, contentType } = exportFileInfo(job.format, completedAt);
  try {
    await deps.exports.complete({
      exportId: input.exportId,
      content,
      fileName,
      contentType,
      completedAt,
      expiresAt: exportExpiresAt(completedAt),
    });
  } catch {
    if (input.receiveCount >= DATA_EXPORT_MAX_RECEIVE) {
      await deps.exports.fail({ exportId: input.exportId, failureCode: "worker_error" });
      return "done";
    }
    await deps.exports.release({ exportId: input.exportId });
    return "retry";
  }
  return "done";
}

export interface CleanupDataExportsSummary {
  readonly expired: number;
  readonly staleFailed: number;
  readonly deleted: number;
}

/**
 * 期限切れの成果物を削除し、停止した job を失敗にし、終了済みの古い行を削除する(EXP-007)。
 * 冪等で、件数だけを返す。
 */
export async function cleanupExpiredDataExportsUseCase(deps: {
  readonly exports: DataExportRepositoryPort;
  readonly now: Clock;
}): Promise<CleanupDataExportsSummary> {
  const now = deps.now();
  const expired = await deps.exports.expireDue({ now, limit: DATA_EXPORT_CLEANUP_BATCH_SIZE });
  const staleFailed = await deps.exports.failStale({
    cutoff: exportStaleCutoff(now),
    limit: DATA_EXPORT_CLEANUP_BATCH_SIZE,
  });
  const deleted = await deps.exports.deleteClosed({
    cutoff: exportRetentionCutoff(now),
    limit: DATA_EXPORT_CLEANUP_BATCH_SIZE,
  });
  return { expired, staleFailed, deleted };
}
