import type { ReminderDeliveryStatus } from "@habit-app/domain";

/**
 * 管理機能が依存する port 群(docs/plans/minimal-admin.md Interfaces and Contracts)。
 * provider・ORM の型をここへ漏らさない。管理者の判定・MFA・閲覧の各メソッドは、
 * 呼び出し側が先に `AdminIdentity` を得ていること(認可済み)を前提とする。
 */

/** 認可を通った管理者。内部 ID は Application 内でのみ使い、外部には公開 ID だけを出す。 */
export interface AdminIdentity {
  readonly adminId: string;
  readonly adminPublicId: string;
}

export interface AdminAccount extends AdminIdentity {
  readonly userId: string;
  readonly totpSecretEnc: string;
  /** 直前に受理した TOTP のステップ(replay 防止)。未使用なら null。 */
  readonly totpLastStep: number | null;
  readonly failedAttempts: number;
  readonly lockedUntil: Date | null;
}

/** リクエストごとの監査用の文脈。IP は不可逆化済み(生の IP を Application に渡さない)。 */
export interface AdminRequestContext {
  readonly requestId: string;
  readonly ipHash: string;
}

export interface AdminAccountRepositoryPort {
  /** 有効(`active`)な管理者のみ。無効・不在・停止中のユーザーは `null`。 */
  findActiveByUserId(userId: string): Promise<AdminAccount | null>;

  /**
   * TOTP の成功を記録する。`step` が直前の受理ステップより大きいときだけ更新し(単一の条件付き UPDATE)、
   * 失敗回数とロックを解除する。更新できたら `true`、replay(同じ/古いステップ)なら `false`。
   */
  recordTotpSuccess(input: {
    readonly adminId: string;
    readonly step: number;
    readonly now: Date;
  }): Promise<boolean>;

  /**
   * 未使用のリカバリーコードを使用済みにする(単回使用。単一の条件付き UPDATE)。
   * 使えたら `true`(同じ transaction で失敗回数とロックを解除)、未登録・使用済みなら `false`。
   */
  consumeRecoveryCode(input: {
    readonly adminId: string;
    readonly codeHash: string;
    readonly now: Date;
  }): Promise<boolean>;

  /**
   * MFA の失敗を原子的に数える。ロック明けの失敗は 1 回目から数え直し、`maxAttempts` に達したら
   * `now + lockoutMs` までロックする。
   */
  recordMfaFailure(input: {
    readonly adminId: string;
    readonly now: Date;
    readonly maxAttempts: number;
    readonly lockoutMs: number;
  }): Promise<{ readonly locked: boolean; readonly lockedUntil: Date | null }>;
}

/**
 * session 単位の MFA 検証時刻。session 行は actor のものだけを対象にする(`userId` を条件に含め、
 * 取得後チェックに頼らない。session ID が誤って他人のものでも更新されない)。
 */
export interface SessionMfaPort {
  /** その session 行の `mfa_verified_at` を設定する。actor の有効な session があれば `true`。 */
  markVerified(input: {
    readonly sessionId: string;
    readonly userId: string;
    readonly now: Date;
  }): Promise<boolean>;
  /** 監査の追記に失敗した場合の取り消し。 */
  clearVerified(input: { readonly sessionId: string; readonly userId: string }): Promise<void>;
}

export interface AuditEntry {
  /** `admin:{adminPublicId}` または `operator`。 */
  readonly actor: string;
  readonly action: string;
  readonly targetType: string;
  readonly targetPublicId: string | null;
  readonly requestId: string;
  readonly ipHash: string;
  readonly now: Date;
}

/** 追記専用。失敗は例外にし、呼び出し側(閲覧 use case)は閲覧を行わない(fail closed)。 */
export interface AuditLogPort {
  append(entry: AuditEntry): Promise<void>;
}

export interface AdminCryptoPort {
  /** 新しい TOTP 秘密を作り、暗号化した値と認証アプリ用の otpauth URI を返す。 */
  enrollTotp(input: { readonly userId: string; readonly accountLabel: string }): {
    readonly encryptedSecret: string;
    readonly otpauthUri: string;
  };

  /** 受理できれば一致したステップ、できなければ `null`。`lastStep` 以下のステップは受理しない。 */
  verifyTotp(input: {
    readonly userId: string;
    readonly encryptedSecret: string;
    readonly code: string;
    readonly nowMs: number;
    readonly lastStep: number | null;
  }): number | null;

  /** 表示用のコードと保存用のハッシュ(同じ順序)を作る。 */
  generateRecoveryCodes(count: number): {
    readonly codes: readonly string[];
    readonly hashes: readonly string[];
  };

  hashRecoveryCode(code: string): string;
}

export interface UserSummary {
  readonly publicId: string;
  /** マスク前の email。use case が即座にマスクし、外へ出さない。 */
  readonly email: string;
  readonly status: string;
  readonly createdAt: Date;
}

export interface UserOverviewRecord extends UserSummary {
  readonly emailVerified: boolean;
  readonly suppressed: boolean;
  readonly notificationDeliveries: Readonly<Record<string, number>>;
  readonly aiJobs: Readonly<Record<string, number>>;
}

export type NotificationFailureStatus = Extract<
  ReminderDeliveryStatus,
  "failed" | "expired" | "suppressed"
>;
export type AiJobFailureStatus = "failed" | "fallback";

export interface NotificationFailureItem {
  readonly id: string;
  readonly userPublicId: string;
  readonly status: string;
  readonly failureCode: string | null;
  readonly attemptCount: number;
  readonly scheduledAt: Date;
  readonly localDate: string;
  readonly updatedAt: Date;
}

export interface AiJobFailureItem {
  /** keyset 用の内部 ID(外部には出さない)。 */
  readonly cursorId: string;
  readonly publicId: string;
  readonly userPublicId: string;
  readonly kind: string;
  readonly status: string;
  readonly failureCode: string | null;
  readonly provider: string;
  readonly model: string;
  readonly promptVersion: string;
  readonly createdAt: Date;
}

/** 閲覧専用の問い合わせ。戻り値は allowlist の項目のみ(email 以外の個人情報・入出力を含めない)。 */
export interface AdminReadPort {
  findUserByEmail(emailNormalized: string): Promise<UserSummary | null>;
  getUserOverview(input: {
    readonly publicId: string;
    readonly since: Date;
  }): Promise<UserOverviewRecord | null>;
  listNotificationFailures(input: {
    readonly statuses: readonly NotificationFailureStatus[];
    readonly limit: number;
    readonly afterId: string | null;
  }): Promise<readonly NotificationFailureItem[]>;
  listAiJobFailures(input: {
    readonly statuses: readonly AiJobFailureStatus[];
    readonly limit: number;
    readonly afterId: string | null;
  }): Promise<readonly AiJobFailureItem[]>;
}

/** 運用スクリプトが使う管理者の付与・無効化(Web/API からは使わない)。 */
export interface AdminProvisioningPort {
  /** email 確認済みで `active` の既存ユーザー。 */
  findEligibleUserByEmail(emailNormalized: string): Promise<{ readonly userId: string } | null>;

  /**
   * 管理者を作る。無効(`disabled`)の管理者は再有効化して MFA を作り直す。
   * すでに有効なら何も変えず `already_active`。同じ transaction でリカバリーコードを置き換え、
   * そのユーザーの全 session の MFA 検証を無効にする。
   */
  grant(input: {
    readonly userId: string;
    readonly totpSecretEnc: string;
    readonly recoveryCodeHashes: readonly string[];
  }): Promise<
    | { readonly status: "granted"; readonly adminPublicId: string }
    | { readonly status: "already_active" }
  >;

  /** 有効な管理者を無効にし、全 session の MFA 検証を無効にする。対象がなければ `null`。 */
  disable(input: { readonly userId: string }): Promise<{ readonly adminPublicId: string } | null>;

  /** 有効な管理者の TOTP 秘密とリカバリーコードを作り直し、全 session の MFA 検証を無効にする。 */
  resetMfa(input: {
    readonly userId: string;
    readonly totpSecretEnc: string;
    readonly recoveryCodeHashes: readonly string[];
  }): Promise<{ readonly adminPublicId: string } | null>;
}
