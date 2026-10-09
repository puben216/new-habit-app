import type { AiJobMessageV1 } from "@habit-app/contracts";
import type { AiJobStatus } from "@habit-app/domain";

/**
 * AI job の永続化・queue の port(docs/plans/ai-queue-pipeline.md)。
 * API 向けのメソッドは `actorUserId` を必須引数に取り、所有者限定(AJOB-INV-001)を query 条件で強制する。
 * worker 向けの `claim` 以降は job の外部 ID だけで引き、job の `userId` を以降の actor とする。
 */

export type AiJobKind = "weekly_improvement" | "habit_design";

/** 永続化済みの job。`id` は外部公開 ID(`ai_jobs.public_id`)で、内部 ID は持たない。 */
export interface AiJobRecord {
  readonly id: string;
  /** 所有者(内部の user ID の十進文字列)。API の応答には出さない。 */
  readonly userId: string;
  readonly kind: AiJobKind;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly status: AiJobStatus;
  readonly promptVersion: string;
  readonly outputSchemaVersion: string;
  readonly provider: string;
  readonly model: string;
  /** 保存済み結果(`result_json`)。読み出し時に use case が schema で検証する。 */
  readonly result: unknown;
  readonly failureCode: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type ClaimAiJobResult =
  | { readonly status: "claimed"; readonly job: AiJobRecord }
  | { readonly status: "not_found" }
  | { readonly status: "finished" }
  | { readonly status: "in_progress" };

export type AttemptOutcome = "succeeded" | "fallback" | "failed" | "error";

/** 1 回の worker 実行の記録。prompt・入力・出力本文は持たない。 */
export interface AiJobAttemptRecord {
  readonly outcome: AttemptOutcome;
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly latencyMs: number;
  /** fallbackReason / failureCode / `worker_error`。本文を含めない。 */
  readonly errorCategory: string | null;
}

export type CompleteAiJobInput = {
  readonly jobId: string;
  readonly attempt: AiJobAttemptRecord;
} & (
  | {
      readonly status: "succeeded" | "fallback";
      readonly model: string;
      /** `AiJobResultV1`。 */
      readonly result: unknown;
    }
  | { readonly status: "failed"; readonly failureCode: string }
);

export interface CreateAiJobInput {
  readonly actorUserId: string;
  readonly kind: AiJobKind;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly promptVersion: string;
  readonly outputSchemaVersion: string;
  readonly provider: string;
  readonly model: string;
  readonly inputFingerprint: string;
  readonly now: Date;
}

export interface AiJobRepositoryPort {
  /** 冪等キー `(actor, kind, subject, promptVersion, fingerprint)` で既存 job を探す。 */
  findByInput(input: {
    readonly actorUserId: string;
    readonly kind: AiJobKind;
    readonly subjectId: string;
    readonly promptVersion: string;
    readonly inputFingerprint: string;
  }): Promise<AiJobRecord | null>;

  /** actor の `queued`/`running` の job 数。 */
  countActive(input: { readonly actorUserId: string }): Promise<number>;

  /**
   * job を `queued` で作成する。同じ冪等キーが既にあれば何も変更せず既存を返す(`created: false`)。
   * 並行実行でも一意制約違反を起こさず、`created: true` を返すのは 1 件のみ。
   * actor の user が存在しなければ `null`。
   */
  createOrGet(
    input: CreateAiJobInput,
  ): Promise<{ readonly job: AiJobRecord; readonly created: boolean } | null>;

  findById(input: {
    readonly actorUserId: string;
    readonly jobId: string;
  }): Promise<AiJobRecord | null>;

  /**
   * job を単一文で claim する(AJOB-003)。`queued`、または lease(`leaseSeconds`。DB の時刻で判定)を
   * 過ぎた `running` だけが `running` になれる。lease 内の `running` は `in_progress`、終端は `finished`。
   */
  claim(input: {
    readonly jobId: string;
    readonly leaseSeconds: number;
  }): Promise<ClaimAiJobResult>;

  /**
   * `running` の job を終端状態へ確定し、attempt を同一 transaction で記録する。`running` でなければ
   * (lease を奪われた等)何も書かず `lost`。
   */
  complete(input: CompleteAiJobInput): Promise<"completed" | "lost">;

  /** `running` の job を `queued` へ戻し、attempt(`error`)を記録する。`running` でなければ何もしない。 */
  release(input: { readonly jobId: string; readonly attempt: AiJobAttemptRecord }): Promise<void>;
}

/** queue への投入 port。実体は SQS(T-501)。message は `jobId` のみ(AJOB-INV-006)。 */
export interface AiJobQueuePort {
  enqueue(message: AiJobMessageV1): Promise<void>;
}
