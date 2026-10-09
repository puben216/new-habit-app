import type { WeeklyReviewSummary } from "@habit-app/domain";

/**
 * 週次レビューの永続化 port(docs/plans/weekly-review.md)。
 * すべてのメソッドが `actorUserId` を必須引数に取り、所有者限定(WREV-INV-001)を query 条件で強制する。
 */

export type WeeklyReviewStatus = "draft" | "completed";

/** 永続化済みのレビュー。`id` は外部公開 ID(`weekly_reviews.public_id`)で、内部 ID は持たない。 */
export interface WeeklyReviewRecord {
  readonly id: string;
  /** ローカル暦日(`YYYY-MM-DD`)。 */
  readonly weekStart: string;
  /** 作成時のプロフィール timezone(`timezone_snapshot`)。 */
  readonly timezone: string;
  /** 保存済みスナップショット(`summary_json`)。読み出し時に use case が schema で検証する。 */
  readonly summary: unknown;
  readonly reflection: string | null;
  readonly status: WeeklyReviewStatus;
  readonly completedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type UpdateWeeklyReviewResult =
  | { readonly status: "ok"; readonly record: WeeklyReviewRecord }
  | { readonly status: "not_found" }
  | { readonly status: "already_completed" };

export interface WeeklyReviewRepositoryPort {
  findByWeekStart(input: {
    readonly actorUserId: string;
    readonly weekStart: string;
  }): Promise<WeeklyReviewRecord | null>;

  /**
   * `(actor, weekStart)` のレビューを `draft` で作成する。既にあれば何も変更せず既存を返す
   * (`created: false`)。並行実行でも一意制約違反を起こさず、`created: true` を返すのは 1 件のみ。
   * actor の user が存在しなければ何も書かず `null` を返す。
   */
  createIfAbsent(input: {
    readonly actorUserId: string;
    readonly weekStart: string;
    readonly timezone: string;
    readonly summary: WeeklyReviewSummary;
    readonly now: Date;
  }): Promise<{ readonly record: WeeklyReviewRecord; readonly created: boolean } | null>;

  findById(input: {
    readonly actorUserId: string;
    readonly reviewId: string;
  }): Promise<WeeklyReviewRecord | null>;

  /**
   * `weekStart` の降順。`beforeWeekStart` が指定されればそれより前の週のみ、最大 `limit` 件を返す。
   * 次ページの有無判定のため、呼び出し側が limit+1 を指定する。
   */
  list(input: {
    readonly actorUserId: string;
    readonly limit: number;
    readonly beforeWeekStart: string | null;
  }): Promise<readonly WeeklyReviewRecord[]>;

  /**
   * `draft` のレビューだけを原子的に更新する(WREV-INV-005)。`reflection` が `undefined` なら変更せず、
   * `complete` なら `status = completed` と `completedAt = now` を同時に設定する。
   * `completed` のレビューは何も変更せず `already_completed`、存在しない・他人のレビューは `not_found`。
   */
  update(input: {
    readonly actorUserId: string;
    readonly reviewId: string;
    readonly reflection: string | null | undefined;
    readonly complete: boolean;
    readonly now: Date;
  }): Promise<UpdateWeeklyReviewResult>;
}
