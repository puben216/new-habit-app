import { isTokenExpired } from "@habit-app/domain";
import type {
  AuthRepositoryPort,
  Clock,
  CreateUserResult,
  EmailSenderPort,
  PasswordHasherPort,
  TokenConsumeResult,
  TokenGeneratorPort,
} from "./ports";

/**
 * auth use case の Unit Test 専用 fake(docs/plans/auth-adapter.md Task 3)。
 * 実際の永続化・暗号化アルゴリズムは持たず、use case のロジックのみを検証する目的の簡易実装。
 * Infrastructure 実装(Task 4)や InMemoryEmailSender(Plan 記載、Integration Test 用)とは別物。
 */

interface MutableAuthUser {
  id: string;
  emailNormalized: string;
  passwordHash: string;
  emailVerifiedAt: Date | null;
}

interface StoredToken {
  readonly userId: string;
  readonly expiresAt: Date;
  usedAt: Date | null;
}

export interface FakeAuthRepository extends AuthRepositoryPort {
  readonly usersByEmail: ReadonlyMap<string, MutableAuthUser>;
}

export function createFakeAuthRepository(): FakeAuthRepository {
  const usersByEmail = new Map<string, MutableAuthUser>();
  const usersById = new Map<string, MutableAuthUser>();
  const verificationTokens = new Map<string, StoredToken>();
  const passwordResetTokens = new Map<string, StoredToken>();
  let nextUserId = 1;

  return {
    usersByEmail,

    async findUserByEmailNormalized(emailNormalized) {
      const user = usersByEmail.get(emailNormalized);
      return user === undefined ? null : { ...user };
    },

    async createUserWithVerificationToken(input): Promise<CreateUserResult> {
      if (usersByEmail.has(input.emailNormalized)) {
        return "already_exists";
      }

      const user: MutableAuthUser = {
        id: `user-${nextUserId}`,
        emailNormalized: input.emailNormalized,
        passwordHash: input.passwordHash,
        emailVerifiedAt: null,
      };
      nextUserId += 1;
      usersByEmail.set(input.emailNormalized, user);
      usersById.set(user.id, user);
      verificationTokens.set(input.verificationTokenHash, {
        userId: user.id,
        expiresAt: input.verificationTokenExpiresAt,
        usedAt: null,
      });
      return "created";
    },

    async replaceVerificationToken(input) {
      for (const [hash, token] of verificationTokens) {
        if (token.userId === input.userId && token.usedAt === null) {
          verificationTokens.delete(hash);
        }
      }
      verificationTokens.set(input.tokenHash, {
        userId: input.userId,
        expiresAt: input.expiresAt,
        usedAt: null,
      });
    },

    async consumeVerificationToken(input): Promise<TokenConsumeResult> {
      const token = verificationTokens.get(input.tokenHash);
      if (
        token === undefined ||
        token.usedAt !== null ||
        isTokenExpired(token.expiresAt, input.now)
      ) {
        return "invalid_or_expired";
      }
      token.usedAt = input.now;
      const user = usersById.get(token.userId);
      if (user !== undefined) {
        user.emailVerifiedAt = input.now;
      }
      return "consumed";
    },

    async createPasswordResetToken(input) {
      passwordResetTokens.set(input.tokenHash, {
        userId: input.userId,
        expiresAt: input.expiresAt,
        usedAt: null,
      });
    },

    async resetPasswordWithToken(input): Promise<TokenConsumeResult> {
      const token = passwordResetTokens.get(input.tokenHash);
      if (
        token === undefined ||
        token.usedAt !== null ||
        isTokenExpired(token.expiresAt, input.now)
      ) {
        return "invalid_or_expired";
      }
      token.usedAt = input.now;
      const user = usersById.get(token.userId);
      if (user !== undefined) {
        user.passwordHash = input.newPasswordHash;
      }
      return "consumed";
    },
  };
}

export function createFakePasswordHasher(): PasswordHasherPort {
  return {
    async hash(password) {
      return `fake-hash:${password}`;
    },
    async verify(password, hash) {
      return hash === `fake-hash:${password}`;
    },
  };
}

export function createFakeTokenGenerator(): TokenGeneratorPort {
  let counter = 0;
  return {
    generate() {
      counter += 1;
      const plaintext = `token-${counter}`;
      return { plaintext, hash: `hash:${plaintext}` };
    },
    hash(plaintext) {
      return `hash:${plaintext}`;
    },
  };
}

export interface FakeEmailSender extends EmailSenderPort {
  readonly sentVerificationEmails: ReadonlyArray<{ readonly to: string; readonly token: string }>;
  readonly sentPasswordResetEmails: ReadonlyArray<{ readonly to: string; readonly token: string }>;
}

export function createFakeEmailSender(): FakeEmailSender {
  const sentVerificationEmails: Array<{ to: string; token: string }> = [];
  const sentPasswordResetEmails: Array<{ to: string; token: string }> = [];

  return {
    sentVerificationEmails,
    sentPasswordResetEmails,
    async sendVerificationEmail(to, token) {
      sentVerificationEmails.push({ to, token });
    },
    async sendPasswordResetEmail(to, token) {
      sentPasswordResetEmails.push({ to, token });
    },
  };
}

export function createFixedClock(date: Date): Clock {
  return () => date;
}
