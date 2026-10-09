/**
 * デイリーチェックインの永続化 port(docs/plans/daily-check-in.md)。
 * すべてのメソッドが `actorUserId` を必須引数に取り、所有者限定(DCI-INV-001)を query 条件で強制する。
 */

export interface DailyCheckInRecord {
  /** ローカル暦日(`YYYY-MM-DD`)。 */
  readonly date: string;
  readonly mood: number | null;
  readonly difficulty: number | null;
  readonly note: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface DailyCheckInRepositoryPort {
  find(input: {
    readonly actorUserId: string;
    readonly date: string;
  }): Promise<DailyCheckInRecord | null>;

  /**
   * `(actor, date)` のチェックインを冪等に作成または全項目置換する。並行実行でも一意制約違反を起こさない。
   * actor の user が存在しなければ何も書かず `null` を返す。
   */
  upsert(input: {
    readonly actorUserId: string;
    readonly date: string;
    readonly mood: number | null;
    readonly difficulty: number | null;
    readonly note: string | null;
    readonly now: Date;
  }): Promise<DailyCheckInRecord | null>;

  /**
   * actor の `[from, to]`(両端を含む)のチェックインを、日付の昇順で返す。他ユーザーのものは含まれない。
   * 週次レビュー(T-301)が週の集計を 1 回の取得で得るために使う。
   */
  listByDateRange(input: {
    readonly actorUserId: string;
    readonly from: string;
    readonly to: string;
  }): Promise<readonly DailyCheckInRecord[]>;
}
