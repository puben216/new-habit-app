import { isTokenExpired } from "@habit-app/domain";
import type {
  AuthRepositoryPort,
  AuthUserRecord,
  CreateUserResult,
  TokenConsumeResult,
} from "@habit-app/application";
import { Prisma, type PrismaClient } from "../generated/prisma/client";

interface UserAuthColumns {
  readonly id: bigint;
  readonly emailNormalized: string;
  readonly passwordHash: string;
  readonly emailVerifiedAt: Date | null;
}

function toAuthUserRecord(user: UserAuthColumns): AuthUserRecord {
  return {
    id: user.id.toString(),
    emailNormalized: user.emailNormalized,
    passwordHash: user.passwordHash,
    emailVerifiedAt: user.emailVerifiedAt,
  };
}

function isUniqueConstraintViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

interface VerificationTokenRow {
  readonly identifier: string;
  readonly expires: Date;
}

interface PasswordResetTokenRow {
  readonly id: bigint;
  readonly user_id: bigint;
  readonly expires_at: Date;
  readonly used_at: Date | null;
}

/**
 * AuthRepositoryPort 実装(Plan: PrismaAuthRepository)。
 * token 検証系メソッド(consumeVerificationToken/resetPasswordWithToken)は
 * `SELECT ... FOR UPDATE` を用いた単一トランザクションで実装し、
 * AUTH-INV-001(同一 token への並行リクエストで成功が最大 1 件)を保証する。
 *
 * users.auth_subject は元々 IdP の不変 subject 用の列(04-database-design.md)だが、
 * Credentials のみの MVP では自然な値がないため "credentials:{emailNormalized}" を格納する。
 * emailNormalized は account 全体で一意なためこの形式も一意になる。将来 OAuth を追加する際は
 * provider ごとの subject 形式に置き換わる(docs/plans/auth-adapter.md Risks 参照)。
 */
export function createPrismaAuthRepository(prisma: PrismaClient): AuthRepositoryPort {
  return {
    async findUserByEmailNormalized(emailNormalized) {
      const user = await prisma.user.findUnique({ where: { emailNormalized } });
      return user === null ? null : toAuthUserRecord(user);
    },

    async createUserWithVerificationToken(input): Promise<CreateUserResult> {
      try {
        await prisma.$transaction(async (tx) => {
          await tx.user.create({
            data: {
              authSubject: `credentials:${input.emailNormalized}`,
              emailNormalized: input.emailNormalized,
              passwordHash: input.passwordHash,
            },
          });
          await tx.verificationToken.create({
            data: {
              identifier: input.emailNormalized,
              token: input.verificationTokenHash,
              expires: input.verificationTokenExpiresAt,
            },
          });
        });
        return "created";
      } catch (error) {
        if (isUniqueConstraintViolation(error)) {
          return "already_exists";
        }
        throw error;
      }
    },

    async replaceVerificationToken(input) {
      await prisma.$transaction(async (tx) => {
        const user = await tx.user.findUniqueOrThrow({ where: { id: BigInt(input.userId) } });
        // 同時に有効な token は常に最大1件(AUTH-004): 既存の未使用 token をすべて削除してから発行する。
        await tx.verificationToken.deleteMany({ where: { identifier: user.emailNormalized } });
        await tx.verificationToken.create({
          data: {
            identifier: user.emailNormalized,
            token: input.tokenHash,
            expires: input.expiresAt,
          },
        });
      });
    },

    async consumeVerificationToken(input): Promise<TokenConsumeResult> {
      return prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<VerificationTokenRow[]>`
          SELECT identifier, expires FROM verification_tokens WHERE token = ${input.tokenHash} FOR UPDATE
        `;
        const token = rows[0];
        if (token === undefined || isTokenExpired(token.expires, input.now)) {
          return "invalid_or_expired";
        }

        // 単回使用性は行の削除で表現する(Auth.js 標準 verification_tokens スキーマに used_at 列がないため)。
        await tx.verificationToken.delete({ where: { token: input.tokenHash } });
        await tx.user.update({
          where: { emailNormalized: token.identifier },
          data: { emailVerifiedAt: input.now },
        });
        return "consumed";
      });
    },

    async createPasswordResetToken(input) {
      await prisma.passwordResetToken.create({
        data: {
          userId: BigInt(input.userId),
          tokenHash: input.tokenHash,
          expiresAt: input.expiresAt,
        },
      });
    },

    async resetPasswordWithToken(input): Promise<TokenConsumeResult> {
      return prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<PasswordResetTokenRow[]>`
          SELECT id, user_id, expires_at, used_at FROM password_reset_tokens
          WHERE token_hash = ${input.tokenHash} FOR UPDATE
        `;
        const token = rows[0];
        if (
          token === undefined ||
          token.used_at !== null ||
          isTokenExpired(token.expires_at, input.now)
        ) {
          return "invalid_or_expired";
        }

        await tx.passwordResetToken.update({
          where: { id: token.id },
          data: { usedAt: input.now },
        });
        await tx.user.update({
          where: { id: token.user_id },
          data: { passwordHash: input.newPasswordHash },
        });
        // password 更新成功時は既存 session をすべて失効させる(AUTH-008)。
        await tx.session.deleteMany({ where: { userId: token.user_id } });
        return "consumed";
      });
    },
  };
}
