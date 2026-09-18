/**
 * auth use case が依存する port(interface)群(docs/plans/auth-adapter.md Interfaces and Contracts)。
 * 実装(Infrastructure)は T-101 Task 4 で行う。ここでは Application が要求する契約のみを定義する。
 */

/** use case から現在時刻を取得するための注入点。テストで固定時刻を渡せるようにする。 */
export type Clock = () => Date;

/** email 登録有無に関わらず外部応答を統一する use case(AUTH-INV-002)の共通戻り値。 */
export interface RequestAcceptedResult {
  readonly accepted: true;
}

export interface PasswordHasherPort {
  hash(password: string): Promise<string>;
  verify(password: string, hash: string): Promise<boolean>;
}

export interface TokenGeneratorPort {
  /** 平文 token とその保存用ハッシュを生成する。 */
  generate(): { readonly plaintext: string; readonly hash: string };
  /** 受け取った平文 token を、generate() と同一アルゴリズムでハッシュ化する(検証時の照合用)。 */
  hash(plaintext: string): string;
}

export interface EmailSenderPort {
  sendVerificationEmail(to: string, token: string): Promise<void>;
  sendPasswordResetEmail(to: string, token: string): Promise<void>;
}

export interface AuthUserRecord {
  readonly id: string;
  readonly emailNormalized: string;
  readonly passwordHash: string;
  readonly emailVerifiedAt: Date | null;
}

export type CreateUserResult = "created" | "already_exists";
export type TokenConsumeResult = "consumed" | "invalid_or_expired";

export interface AuthRepositoryPort {
  findUserByEmailNormalized(emailNormalized: string): Promise<AuthUserRecord | null>;

  /**
   * user 作成と verification token 発行を単一トランザクションで行う。
   * emailNormalized が既に存在する場合は何も作成せず "already_exists" を返す(AUTH-INV-002)。
   */
  createUserWithVerificationToken(input: {
    readonly emailNormalized: string;
    readonly passwordHash: string;
    readonly verificationTokenHash: string;
    readonly verificationTokenExpiresAt: Date;
  }): Promise<CreateUserResult>;

  /** 再送(AUTH-004)のため、当該 user の未使用 verification token を無効化し新しい token に置き換える。 */
  replaceVerificationToken(input: {
    readonly userId: string;
    readonly tokenHash: string;
    readonly expiresAt: Date;
  }): Promise<void>;

  /**
   * verification token を検証し、成功時は該当 user を email 確認済みにする。
   * token の検証〜使用済みへの更新〜user 更新は単一トランザクションで行い、
   * 同一 token への並行リクエストで成功が最大 1 件になるようにする(AUTH-INV-001)。
   */
  consumeVerificationToken(input: {
    readonly tokenHash: string;
    readonly now: Date;
  }): Promise<TokenConsumeResult>;

  createPasswordResetToken(input: {
    readonly userId: string;
    readonly tokenHash: string;
    readonly expiresAt: Date;
  }): Promise<void>;

  /**
   * password reset token を検証し、成功時は password を更新したうえで
   * 当該 user の既存 session をすべて失効させる(AUTH-008)。token 検証・password 更新・
   * session 失効は単一トランザクションで行い、AUTH-INV-001 を満たす。
   */
  resetPasswordWithToken(input: {
    readonly tokenHash: string;
    readonly newPasswordHash: string;
    readonly now: Date;
  }): Promise<TokenConsumeResult>;
}

export type LoginAttemptPurpose = "signup" | "login" | "verify_resend" | "password_reset";

/**
 * AUTH-010 の rate limit/lockout 判定に使う port。
 * 定義のみ Task 3 で行い、use case への組み込みは Task 6(Plan Task Breakdown)で行う。
 */
export interface LoginAttemptPort {
  record(purpose: LoginAttemptPurpose, emailNormalized: string, succeeded: boolean): Promise<void>;
  isBlocked(purpose: LoginAttemptPurpose, emailNormalized: string): Promise<boolean>;
  /** 判定ウィンドウを超えた履歴を削除する(retention)。 */
  pruneExpired(): Promise<void>;
}
