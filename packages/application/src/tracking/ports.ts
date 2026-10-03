import type { HabitEntryStatus } from "@habit-app/domain";

/**
 * tracking use case が依存する port(docs/plans/habit-entry.md Interfaces and Contracts)。
 * 実装(Infrastructure)は PrismaHabitEntryRepository。
 * すべてのメソッドが `actorUserId` を必須引数に取り、所有者限定(HENT-INV-001)を query 条件で強制する。
 */

/** 永続化済みの記録。`habitId` は習慣の外部 ID(`habits.public_id`)。内部 ID は持たない。 */
export interface HabitEntryRecord {
  readonly habitId: string;
  /** ローカル暦日(`YYYY-MM-DD`)。 */
  readonly date: string;
  readonly status: HabitEntryStatus;
  readonly quantity: number | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface HabitEntryRepositoryPort {
  /**
   * `(habit, date)` の記録を冪等に作成または上書きする。並行実行でも一意制約違反を起こさない。
   * 習慣が actor のものとして存在しなければ何も書かず `null` を返す。
   */
  upsert(input: {
    readonly actorUserId: string;
    readonly habitId: string;
    readonly date: string;
    readonly status: HabitEntryStatus;
    readonly quantity: number | null;
    readonly now: Date;
  }): Promise<HabitEntryRecord | null>;

  /** actor の、指定した日の記録をすべて返す(他ユーザーの記録は含まれない)。 */
  listByDate(input: {
    readonly actorUserId: string;
    readonly date: string;
  }): Promise<readonly HabitEntryRecord[]>;
}
