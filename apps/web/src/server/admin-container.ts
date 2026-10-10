import { randomUUID } from "node:crypto";
import {
  authorizeAdmin,
  getUserOverviewUseCase,
  listAiJobFailuresUseCase,
  listNotificationFailuresUseCase,
  searchUserByEmailUseCase,
  verifyAdminMfaUseCase,
} from "@habit-app/application";
import type { Clock } from "@habit-app/application";
import {
  createAdminCrypto,
  createIpHasher,
  createPrismaAdminAccountRepository,
  createPrismaAdminReadRepository,
  createPrismaAuditLogRepository,
  createPrismaSessionMfaRepository,
} from "@habit-app/infrastructure";

import { getAuthContainer } from "./auth-container";
import { createAdminHandlers } from "./admin-handlers";
import type { AdminHandlers } from "./admin-handlers";
import { getServerEnv } from "./env";
import { adminSessionFromAuth } from "./session-actor";

/**
 * `/api/v1/admin/*` の composition root(T-403)。他の container と同様、初回リクエスト時まで構築を遅延させる
 * (`next build` が env 検証や DB 接続を実行しないようにするため)。
 * 暗号鍵・HMAC 鍵が未設定なら構築に失敗し、管理 API は 500 を返す(鍵なしで動作しない)。
 * 管理者かどうかは毎回 DB で判定する(`authorizeAdmin`)。session や client に持たせない。
 */
async function buildAdminHandlers(): Promise<AdminHandlers> {
  const env = getServerEnv();
  if (env.ADMIN_TOTP_ENCRYPTION_KEY === undefined || env.AUDIT_IP_HASH_KEY === undefined) {
    throw new Error(
      "ADMIN_TOTP_ENCRYPTION_KEY and AUDIT_IP_HASH_KEY are required for the admin API",
    );
  }
  const { auth, prisma } = await getAuthContainer();

  const adminRepository = createPrismaAdminAccountRepository(prisma);
  const sessionMfa = createPrismaSessionMfaRepository(prisma);
  const audit = createPrismaAuditLogRepository(prisma);
  const read = createPrismaAdminReadRepository(prisma);
  const crypto = createAdminCrypto(env.ADMIN_TOTP_ENCRYPTION_KEY);
  const now: Clock = () => new Date();

  return createAdminHandlers({
    resolveSession: async () => adminSessionFromAuth(await auth()),
    authorize: (input) => authorizeAdmin({ adminRepository, now }, input),
    allowedOrigin: new URL(env.APP_BASE_URL).origin,
    hashIp: createIpHasher(env.AUDIT_IP_HASH_KEY),
    newRequestId: randomUUID,
    now,
    useCases: {
      verifyMfa: (input) =>
        verifyAdminMfaUseCase({ adminRepository, sessionMfa, crypto, audit, now }, input),
      searchUser: (input) => searchUserByEmailUseCase({ read, audit, now }, input),
      getUserOverview: (input) => getUserOverviewUseCase({ read, audit, now }, input),
      listNotificationFailures: (input) =>
        listNotificationFailuresUseCase({ read, audit, now }, input),
      listAiJobFailures: (input) => listAiJobFailuresUseCase({ read, audit, now }, input),
    },
  });
}

let handlersPromise: Promise<AdminHandlers> | undefined;

/** 初期化の失敗はキャッシュしない(設定の修正後に再起動なしで回復できる)。 */
export function getAdminHandlers(): Promise<AdminHandlers> {
  if (handlersPromise === undefined) {
    const attempt = buildAdminHandlers();
    handlersPromise = attempt;
    attempt.catch(() => {
      if (handlersPromise === attempt) handlersPromise = undefined;
    });
  }
  return handlersPromise;
}
