import { randomUUID } from "node:crypto";
import {
  cancelAccountDeletionUseCase,
  getAccountDeletionStatusUseCase,
  requestAccountDeletionUseCase,
} from "@habit-app/application";
import type { Clock } from "@habit-app/application";
import {
  createIpHasher,
  createPrismaAccountRepository,
  createPrismaLoginAttemptRepository,
} from "@habit-app/infrastructure";

import { createAccountDeletionHandlers } from "./account-deletion-handlers";
import type { AccountDeletionHandlers } from "./account-deletion-handlers";
import { getAuthContainer } from "./auth-container";
import { getServerEnv } from "./env";
import { accountSessionFromAuth, actorUserIdFromSession } from "./session-actor";

/**
 * アカウント削除 API の composition root(T-404)。他の container と同様、初回リクエスト時まで構築を遅延させる
 * (`next build` が env 検証や DB 接続を実行しないようにするため)。
 * `AUDIT_IP_HASH_KEY` が未設定でも動作する(監査の IP は固定値 `none` になる)。
 */
async function buildAccountDeletionHandlers(): Promise<AccountDeletionHandlers> {
  const env = getServerEnv();
  const { auth, prisma, passwordHasher } = await getAuthContainer();

  const accounts = createPrismaAccountRepository(prisma);
  const attempts = createPrismaLoginAttemptRepository(prisma);
  const hashIp =
    env.AUDIT_IP_HASH_KEY === undefined
      ? (): string => "none"
      : createIpHasher(env.AUDIT_IP_HASH_KEY);
  const now: Clock = () => new Date();

  return createAccountDeletionHandlers({
    // 認証(誰か)のみをここで判定する。認可(自分のアカウントのみ)は actor の取り出し方で決まる。
    resolveActorUserId: async () => actorUserIdFromSession(await auth()),
    resolveAccountSession: async () => accountSessionFromAuth(await auth()),
    allowedOrigin: new URL(env.APP_BASE_URL).origin,
    hashIp,
    newRequestId: randomUUID,
    useCases: {
      request: (input) =>
        requestAccountDeletionUseCase({ accounts, passwordHasher, attempts, now }, input),
      cancel: (input) => cancelAccountDeletionUseCase({ accounts, now }, input),
      status: (input) => getAccountDeletionStatusUseCase({ accounts }, input),
    },
  });
}

let handlersPromise: Promise<AccountDeletionHandlers> | undefined;

export function getAccountDeletionHandlers(): Promise<AccountDeletionHandlers> {
  handlersPromise ??= buildAccountDeletionHandlers();
  return handlersPromise;
}
