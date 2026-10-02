import type { ProfileChanges, UserProfile } from "@habit-app/domain";

/** use case が扱う認証済みの操作主体。session の解決は Presentation の責務で、ここでは ID のみを受ける。 */
export interface Actor {
  readonly userId: string;
}

/** 永続化されたプロフィール。`userId` は所有権の再確認(policy)に使い、外部へは返さない。 */
export interface ProfileRecord extends UserProfile {
  readonly userId: string;
  readonly updatedAt: Date;
}

/** 呼び出し側(Presentation)へ返すプロフィール。内部 ID を含まない。 */
export interface ProfileView extends UserProfile {
  readonly updatedAt: Date;
}

/**
 * プロフィールの永続化 port(docs/specs/user-profile.md)。
 * すべての操作は actor の user ID を条件にする。`null` は対応する user が存在しないことを表す。
 */
export interface ProfileRepositoryPort {
  /**
   * プロフィールが未作成なら `defaults` で作成し(並行実行でも 1 行のみ・例外なし)、
   * 現在のプロフィールを返す。既存の行は上書きしない。
   */
  ensure(userId: string, defaults: UserProfile): Promise<ProfileRecord | null>;

  /** 指定された項目のみを更新し、更新後のプロフィールを返す。行が存在しなければ `null`。 */
  update(userId: string, changes: ProfileChanges): Promise<ProfileRecord | null>;
}
