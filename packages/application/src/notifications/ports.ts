import type { QuietHours } from "@habit-app/domain";

/**
 * 通知設定の永続化 port(docs/plans/notification-preferences.md)。
 * すべてのメソッドが `actorUserId` を必須引数に取り、所有者限定(NPF-INV-001)を query 条件で強制する。
 * 本 port が扱うのはユーザー単位の設定(`habit_id IS NULL`)のみ。
 */

export interface NotificationSettingsRecord {
  readonly enabled: boolean;
  /** `HH:mm`。`timezone` のローカル時刻。 */
  readonly localTime: string;
  readonly timezone: string;
  readonly quietHours: QuietHours | null;
  readonly updatedAt: Date;
}

export interface NotificationSettingsRepositoryPort {
  find(input: { readonly actorUserId: string }): Promise<NotificationSettingsRecord | null>;

  /**
   * actor のユーザー単位の設定を冪等に作成または全項目置換する。並行実行でも一意制約違反を起こさない。
   * actor の user が存在しなければ何も書かず `null` を返す。
   */
  upsert(input: {
    readonly actorUserId: string;
    readonly enabled: boolean;
    readonly localTime: string;
    readonly timezone: string;
    readonly quietHours: QuietHours | null;
    readonly now: Date;
  }): Promise<NotificationSettingsRecord | null>;
}
