import { cleanupExpiredDataExportsUseCase, handleDataExportMessages } from "@habit-app/application";
import type { Clock } from "@habit-app/application";
import { isDataExportEnabled, parseWorkerEnv } from "@habit-app/config";
import type { EnvSource, WorkerEnv } from "@habit-app/config";
import {
  createDataExportProcessDeps,
  createPrismaClient,
  createSecretsManagerClient,
  createSecretsReader,
} from "@habit-app/infrastructure/worker";
import type { PrismaClient } from "@habit-app/infrastructure/worker";

import { memoizeAsync } from "../notification/memoize";
import { consoleLogger, createCleanupHandler, createProcessHandler } from "./handlers";

/**
 * データエクスポートの Lambda の composition root(docs/plans/data-export.md)。
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

async function buildProcess(source: EnvSource) {
  if (!isDataExportEnabled(source)) {
    return createProcessHandler({
      enabled: false,
      handle: () => {
        throw new Error("handler is disabled");
      },
      log: consoleLogger,
    });
  }
  const env = parseWorkerEnv(source);
  const prisma = await loadPrisma(env);
  const deps = createDataExportProcessDeps(prisma);
  return createProcessHandler({
    enabled: true,
    handle: (batch) => handleDataExportMessages(deps, batch),
    log: consoleLogger,
  });
}

async function buildCleanup(source: EnvSource) {
  if (!isDataExportEnabled(source)) {
    return createCleanupHandler({
      enabled: false,
      run: () => {
        throw new Error("handler is disabled");
      },
      log: consoleLogger,
    });
  }
  const env = parseWorkerEnv(source);
  const prisma = await loadPrisma(env);
  const { exports } = createDataExportProcessDeps(prisma);
  const now: Clock = () => new Date();
  return createCleanupHandler({
    enabled: true,
    run: () => cleanupExpiredDataExportsUseCase({ exports, now }),
    log: consoleLogger,
  });
}

let processHandler: (() => ReturnType<typeof buildProcess>) | undefined;
let cleanupHandler: (() => ReturnType<typeof buildCleanup>) | undefined;

export function getProcess(source: EnvSource = process.env) {
  processHandler ??= memoizeAsync(() => buildProcess(source));
  return processHandler();
}

export function getCleanup(source: EnvSource = process.env) {
  cleanupHandler ??= memoizeAsync(() => buildCleanup(source));
  return cleanupHandler();
}
