import type { Env } from "@habit-app/config";
import type {
  AuthRepositoryPort,
  Clock,
  EmailSenderPort,
  PasswordHasherPort,
  TokenGeneratorPort,
} from "@habit-app/application";
import {
  createArgon2PasswordHasher,
  createAuthHandlers,
  createCryptoTokenGenerator,
  createDummyPasswordHash,
  createPrismaAuthRepository,
  createPrismaClient,
  createSmtpEmailSender,
  type AuthHandlersDeps,
  type PrismaClient,
} from "@habit-app/infrastructure";

import type { NextAuthResult } from "next-auth";

import { getServerEnv } from "./env";

/**
 * apps/web の auth route handler(T-101 Task 5)が共有する composition root。
 *
 * env 検証・PrismaClient・NextAuth ハンドラーの構築は、モジュール読み込み時ではなく
 * 初回リクエスト時まで遅延させる(遅延 singleton)。`next build` はページ/route data
 * 収集のために各 route module を import するだけで実行はしないが、モジュール scope で
 * 副作用(env 検証や DB 接続)を実行すると import されただけでビルドが失敗してしまう
 * (実際に本番向け env 未整備の状態で `next build` が壊れる不具合として発覚したため、
 * 2026-09-28 にこの構造へ変更した)。
 */
interface AuthContainer {
  readonly authRepository: AuthRepositoryPort;
  readonly passwordHasher: PasswordHasherPort;
  readonly tokenGenerator: TokenGeneratorPort;
  readonly emailSender: EmailSenderPort;
  readonly clock: Clock;
  readonly authHandlers: NextAuthResult["handlers"];
  /** session 取得(AUTH-009)。route handler から actor user ID を得るために使う(T-102)。 */
  readonly auth: NextAuthResult["auth"];
  /** 他の module の repository を組み立てるための共有 PrismaClient(T-102)。 */
  readonly prisma: PrismaClient;
}

const globalForPrisma = globalThis as unknown as { __habitAppPrisma?: PrismaClient };

function createEmailSender(env: Env): EmailSenderPort {
  if (env.AUTH_EMAIL_SENDER === "smtp") {
    return createSmtpEmailSender({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      from: env.EMAIL_FROM,
      verificationUrlBase: `${env.APP_BASE_URL}/verify-email`,
      passwordResetUrlBase: `${env.APP_BASE_URL}/password-reset/confirm`,
    });
  }
  // 認証メールのSES送信はT-405で実装する(T-402はリマインド通知のSES送信のみ)。
  throw new Error("AUTH_EMAIL_SENDER=ses はまだ実装されていません(T-405)");
}

async function buildAuthContainer(): Promise<AuthContainer> {
  const env = getServerEnv();

  const prisma: PrismaClient =
    globalForPrisma.__habitAppPrisma ?? createPrismaClient(env.DATABASE_URL);
  if (env.NODE_ENV !== "production") {
    globalForPrisma.__habitAppPrisma = prisma;
  }

  const authRepository = createPrismaAuthRepository(prisma);
  const passwordHasher = createArgon2PasswordHasher();
  const tokenGenerator = createCryptoTokenGenerator();
  const emailSender = createEmailSender(env);
  const clock: Clock = () => new Date();

  // AUTH-INV-002(処理時間差の排除)用。初回構築時に一度だけ計算する(login のたびに計算し直さない)。
  const dummyPasswordHash = await createDummyPasswordHash(passwordHasher);

  const authHandlersDeps: AuthHandlersDeps = {
    authRepository,
    passwordHasher,
    tokenGenerator,
    dummyPasswordHash,
    authSecret: env.AUTH_SECRET,
  };
  const { handlers: authHandlers, auth } = createAuthHandlers(authHandlersDeps);

  return {
    authRepository,
    passwordHasher,
    tokenGenerator,
    emailSender,
    clock,
    authHandlers,
    auth,
    prisma,
  };
}

let containerPromise: Promise<AuthContainer> | undefined;

export function getAuthContainer(): Promise<AuthContainer> {
  containerPromise ??= buildAuthContainer();
  return containerPromise;
}
