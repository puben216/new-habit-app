import { randomUUID } from "node:crypto";
import { purgeExpiredAccountsUseCase } from "@habit-app/application";
import type { Clock } from "@habit-app/application";
import { isAccountPurgeEnabled, parseWorkerEnv } from "@habit-app/config";
import type { EnvSource, WorkerEnv } from "@habit-app/config";
import {
  createNoopExternalDataCleanup,
  createPrismaAccountRepository,
  createPrismaClient,
  createSecretsManagerClient,
  createSecretsReader,
} from "@habit-app/infrastructure/worker";
import type { PrismaClient } from "@habit-app/infrastructure/worker";

import { memoizeAsync } from "../notification/memoize";
import { consoleLogger, createPurgeHandler } from "./handlers";

/**
 * アカウント削除ジョブの composition root(docs/plans/account-deletion.md)。
 * 実行環境(コールドスタート)ごとに 1 回だけ構築する。Feature Flag が無効の間は、DB・AWS へ接続せず、
 * 環境変数も検証しない。secret は Secrets Manager から読み、値をログ・エラーに含めない。
 */

function requireValue<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`${name} is required`);
  return value;
}

async function loadPrisma(env: WorkerEnv): Promise<PrismaClient> {
  const databaseUrl =
    env.DATABASE_URL ??
    (await createSecretsReader({
      client: createSecretsManagerClient({ region: env.AWS_REGION }),
    }).getSecretString(requireValue(env.DATABASE_URL_SECRET_ARN, "DATABASE_URL_SECRET_ARN")));
  return createPrismaClient(databaseUrl);
}

async function buildPurge(source: EnvSource) {
  if (!isAccountPurgeEnabled(source)) {
    return createPurgeHandler({
      enabled: false,
      run: () => {
        throw new Error("handler is disabled");
      },
      log: consoleLogger,
    });
  }
  const env = parseWorkerEnv(source);
  const prisma = await loadPrisma(env);
  const now: Clock = () => new Date();
  return createPurgeHandler({
    enabled: true,
    run: () =>
      purgeExpiredAccountsUseCase({
        accounts: createPrismaAccountRepository(prisma),
        // AI・メールの provider が未確定のため何もしない(ADR-003)。provider の実装時に差し替える。
        cleanup: createNoopExternalDataCleanup(),
        now,
        newRequestId: randomUUID,
      }),
    log: consoleLogger,
  });
}

let purge: (() => ReturnType<typeof buildPurge>) | undefined;

export function getPurge(source: EnvSource = process.env) {
  purge ??= memoizeAsync(() => buildPurge(source));
  return purge();
}
