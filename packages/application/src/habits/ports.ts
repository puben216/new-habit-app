import type { Habit } from "@habit-app/domain";

/**
 * habits use case が依存する port 群(docs/plans/habit-api.md Interfaces and Contracts)。
 * 実装(Infrastructure)は PrismaHabitRepository。
 *
 * すべてのメソッドが `actorUserId` を必須引数に取る。所有者限定(HAPI-INV-001)を
 * 「取得後チェック」ではなく query 条件として実装側に強制するため。
 */

/** 永続化済みの Habit と、永続化層が管理するメタデータ。 */
export interface HabitRecord {
  readonly habit: Habit;
  /** 楽観ロック用。作成時 1、状態変更ごとに +1。 */
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type HabitListStatus = "active" | "archived";

export type ListHabitsRepositoryResult =
  | { readonly ok: true; readonly items: readonly HabitRecord[] }
  /** afterHabitId が actor の習慣として存在しない(他ユーザー/不存在)。 */
  | { readonly ok: false; readonly reason: "cursor_not_found" };

export type SaveHabitResult =
  | { readonly status: "saved"; readonly record: HabitRecord }
  /** 永続化済みの version が expectedVersion と異なる(並行更新)。何も変更されない。 */
  | { readonly status: "conflict" }
  /** actor の習慣として存在しない。何も変更されない。 */
  | { readonly status: "not_found" };

export interface HabitRepositoryPort {
  /** 新規習慣を version=1 で保存する。createdAt/updatedAt は `now`(ミリ秒精度)。 */
  create(input: {
    readonly actorUserId: string;
    readonly habit: Habit;
    readonly now: Date;
  }): Promise<HabitRecord>;

  findById(input: {
    readonly actorUserId: string;
    readonly habitId: string;
  }): Promise<HabitRecord | null>;

  /**
   * `(createdAt desc, id desc)` 順。`afterHabitId` の次の位置から最大 `limit` 件を返す。
   * 次ページの有無判定のため、呼び出し側が limit+1 を指定する。
   */
  list(input: {
    readonly actorUserId: string;
    readonly status: HabitListStatus;
    readonly limit: number;
    readonly afterHabitId: string | null;
  }): Promise<ListHabitsRepositoryResult>;

  /**
   * 習慣行(詳細・status)と ScheduleVersion の変更を単一 transaction で反映する。
   * 永続化済みの version が expectedVersion と一致する場合のみ適用し、version を 1 増やす
   * (HAPI-INV-002)。
   */
  save(input: {
    readonly actorUserId: string;
    readonly habit: Habit;
    readonly expectedVersion: number;
    readonly now: Date;
  }): Promise<SaveHabitResult>;
}

/** 外部公開 ID(UUID)の採番。Domain は ID を生成しない(docs/specs/habit-domain.md)。 */
export interface IdGeneratorPort {
  generate(): string;
}
