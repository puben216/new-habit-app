import type {
  DataExportFailureCode,
  DataExportFormat,
  DataExportStatus,
  ExportBundle,
} from "@habit-app/domain";
import type { DataExportMessageV1 } from "@habit-app/contracts";

import type { AccountRequestContext } from "../account";

/**
 * データエクスポートの port(docs/plans/data-export.md)。
 * API 向けのメソッドは `actorUserId` を必須引数に取り、所有者限定(EXP-INV-001)を query 条件で強制する。
 * worker 向けの `claim` 以降は job の外部 ID だけで引き、job の `userId` を以降の actor とする。
 */

/** 永続化済みのエクスポート。`id` は外部公開 ID(`data_exports.public_id`)で、内部 ID は持たない。 */
export interface DataExportRecord {
  readonly id: string;
  /** 所有者(内部の user ID の十進文字列)。API の応答には出さない。 */
  readonly userId: string;
  readonly format: DataExportFormat;
  readonly status: DataExportStatus;
  readonly failureCode: DataExportFailureCode | null;
  readonly byteSize: number | null;
  readonly fileName: string | null;
  readonly contentType: string | null;
  readonly createdAt: Date;
  readonly completedAt: Date | null;
  readonly expiresAt: Date | null;
}

export type CreateDataExportResult =
  | { readonly status: "created"; readonly export: DataExportRecord }
  | { readonly status: "in_progress" }
  | { readonly status: "rate_limited" }
  | { readonly status: "not_found" };

export type ClaimDataExportResult =
  | { readonly status: "claimed"; readonly export: DataExportRecord }
  | { readonly status: "not_found" }
  | { readonly status: "finished" }
  | { readonly status: "in_progress" };

export type ReadArtifactResult =
  | { readonly status: "ok"; readonly export: DataExportRecord; readonly content: Uint8Array }
  | { readonly status: "not_found" }
  | { readonly status: "not_ready" }
  | { readonly status: "expired" };

export interface CompleteDataExportInput {
  readonly exportId: string;
  readonly content: Uint8Array;
  readonly fileName: string;
  readonly contentType: string;
  readonly completedAt: Date;
  readonly expiresAt: Date;
}

export interface DataExportRepositoryPort {
  /**
   * 頻度の上限と実行中の有無を確認し、`queued` で作成する(EXP-001)。同一 transaction で、完成済みの古い
   * エクスポートを無効にし(成果物の削除)、監査(`user.export.requested`)を追記する。
   * 並行する作成は部分 unique index で 1 件だけが成立し、残りは `in_progress`。actor の user が存在しなければ `not_found`。
   */
  createIfAllowed(input: {
    readonly actorUserId: string;
    readonly format: DataExportFormat;
    readonly now: Date;
    /** この時刻以降に作成されたものを数える。 */
    readonly windowStart: Date;
    readonly dailyLimit: number;
    /**
     * この時刻以前から更新されていない自分の `queued`/`running` は停止したとみなし、`failed(worker_error)` に
     * してから判定する。投入前のプロセス停止などで行が残り、永久に作成できなくなることを防ぐ。
     */
    readonly staleBefore: Date;
    readonly context: AccountRequestContext;
  }): Promise<CreateDataExportResult>;

  /** 直近の作成順(新しい順)に最大 `limit` 件。 */
  list(input: {
    readonly actorUserId: string;
    readonly limit: number;
  }): Promise<readonly DataExportRecord[]>;

  /**
   * job を単一文で claim する(EXP-002)。`queued`、または lease(DB の時刻で判定)を過ぎた `running` だけが
   * `running` になれる。lease 内の `running` は `in_progress`、終端は `finished`。
   */
  claim(input: {
    readonly exportId: string;
    readonly leaseSeconds: number;
  }): Promise<ClaimDataExportResult>;

  /** `running` の job を `ready` へ確定し、成果物を同一 transaction で保存する。`running` でなければ `lost`。 */
  complete(input: CompleteDataExportInput): Promise<"completed" | "lost">;

  /** `queued`/`running` の job を `failed` にする。終端の job は変更しない。 */
  fail(input: {
    readonly exportId: string;
    readonly failureCode: DataExportFailureCode;
  }): Promise<void>;

  /** `running` の job を `queued` へ戻す。`running` でなければ何もしない。 */
  release(input: { readonly exportId: string }): Promise<void>;

  /**
   * 自分の成果物を読む(EXP-004)。所有者・状態・期限の判定の後、**監査(`user.export.downloaded`)を先に
   * 追記してから**成果物を読む。監査の追記に失敗したら読まない(fail closed)。
   */
  readArtifact(input: {
    readonly actorUserId: string;
    readonly exportId: string;
    readonly now: Date;
    readonly context: AccountRequestContext;
  }): Promise<ReadArtifactResult>;

  /** `ready` で期限(`expires_at <= now`)を過ぎたものの成果物を削除し `expired` にする。処理した件数を返す。 */
  expireDue(input: { readonly now: Date; readonly limit: number }): Promise<number>;

  /** `queued`/`running` で `updated_at <= cutoff`(停止したとみなす)の job を `failed(worker_error)` にする。件数を返す。 */
  failStale(input: { readonly cutoff: Date; readonly limit: number }): Promise<number>;

  /** `failed`/`expired` で `updated_at <= cutoff` の行を削除する。削除した件数を返す。 */
  deleteClosed(input: { readonly cutoff: Date; readonly limit: number }): Promise<number>;
}

/** 一貫したスナップショットで、許可リストの項目だけを収集する(EXP-005)。 */
export interface ExportDataSourcePort {
  collect(input: { readonly userId: string }): Promise<ExportBundle>;
}

export interface DataExportQueuePort {
  enqueue(message: DataExportMessageV1): Promise<void>;
}
