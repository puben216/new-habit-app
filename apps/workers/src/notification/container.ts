import {
  deliverReminderUseCase,
  handleEmailFeedbackUseCase,
  hasUnrecordedScheduledHabitsUseCase,
  scheduleDueRemindersUseCase,
} from "@habit-app/application";
import type { Clock } from "@habit-app/application";
import { isNotificationDeliveryEnabled, parseWorkerEnv } from "@habit-app/config";
import type { EnvSource, WorkerEnv } from "@habit-app/config";
import {
  createHmacUnsubscribeTokenSigner,
  createPrismaClient,
  createPrismaEmailSuppressionRepository,
  createPrismaHabitEntryRepository,
  createPrismaHabitRepository,
  createPrismaNotificationSettingsRepository,
  createPrismaRecipientRepository,
  createPrismaReminderDeliveryRepository,
  createSecretsManagerClient,
  createSecretsReader,
  createSesClient,
  createSesReminderSender,
  createSqsClient,
  createSqsReminderQueue,
} from "@habit-app/infrastructure/worker";
import type { PrismaClient, SecretsReader } from "@habit-app/infrastructure/worker";

import {
  consoleLogger,
  createDeliveryHandler,
  createFeedbackHandler,
  createSchedulerHandler,
} from "./handlers";
import { memoizeAsync } from "./memoize";

/**
 * Lambda の composition root(docs/plans/notification-delivery.md)。
 * Lambda ごとに必要なものだけを構築する(最小権限・最小設定。例: feedback は SES・SQS・署名鍵を要求しない)。
 * 実行環境(コールドスタート)ごとに 1 回だけ構築し、以降の invocation で再利用する。
 * Feature Flag が無効の間、scheduler/delivery は DB・AWS へ接続せず、環境変数も検証しない。
 * secret は Secrets Manager から読み、値をログ・エラーに含めない。
 */

function requireValue<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`${name} is required`);
  return value;
}

let secretsPromise: Promise<SecretsReader> | undefined;
let prismaPromise: Promise<PrismaClient> | undefined;

function getSecrets(env: WorkerEnv): Promise<SecretsReader> {
  secretsPromise ??= Promise.resolve(
    createSecretsReader({ client: createSecretsManagerClient({ region: env.AWS_REGION }) }),
  );
  return secretsPromise;
}

function getPrisma(env: WorkerEnv): Promise<PrismaClient> {
  prismaPromise ??= (async () => {
    const databaseUrl =
      env.DATABASE_URL ??
      (await (
        await getSecrets(env)
      ).getSecretString(requireValue(env.DATABASE_URL_SECRET_ARN, "DATABASE_URL_SECRET_ARN")));
    return createPrismaClient(databaseUrl);
  })();
  return prismaPromise;
}

async function buildScheduler(source: EnvSource) {
  const log = consoleLogger;
  if (!isNotificationDeliveryEnabled(source)) {
    return createSchedulerHandler({ enabled: false, run: unreachable, log });
  }
  const env = parseWorkerEnv(source);
  const prisma = await getPrisma(env);
  const queue = createSqsReminderQueue({
    client: createSqsClient({ region: env.AWS_REGION }),
    queueUrl: requireValue(env.NOTIFICATION_QUEUE_URL, "NOTIFICATION_QUEUE_URL"),
  });
  const deliveryRepository = createPrismaReminderDeliveryRepository(prisma);
  const now: Clock = () => new Date();
  return createSchedulerHandler({
    enabled: true,
    run: () => scheduleDueRemindersUseCase({ deliveryRepository, queue, now }),
    log,
  });
}

async function buildDelivery(source: EnvSource) {
  const log = consoleLogger;
  if (!isNotificationDeliveryEnabled(source)) {
    return createDeliveryHandler({ enabled: false, deliver: unreachable, log });
  }
  const env = parseWorkerEnv(source);
  const prisma = await getPrisma(env);
  const signingKey =
    env.UNSUBSCRIBE_SIGNING_KEY ??
    (await (
      await getSecrets(env)
    ).getSecretString(
      requireValue(env.UNSUBSCRIBE_SIGNING_KEY_SECRET_ARN, "UNSUBSCRIBE_SIGNING_KEY_SECRET_ARN"),
    ));

  const habitRepository = createPrismaHabitRepository(prisma);
  const entryRepository = createPrismaHabitEntryRepository(prisma);
  const deps = {
    deliveryRepository: createPrismaReminderDeliveryRepository(prisma),
    settingsRepository: createPrismaNotificationSettingsRepository(prisma),
    suppressions: createPrismaEmailSuppressionRepository(prisma),
    recipients: createPrismaRecipientRepository(prisma),
    emailSender: createSesReminderSender({
      client: createSesClient({ region: env.AWS_REGION }),
      from: requireValue(env.EMAIL_FROM, "EMAIL_FROM"),
      configurationSet: requireValue(env.SES_CONFIGURATION_SET, "SES_CONFIGURATION_SET"),
    }),
    unsubscribeTokens: createHmacUnsubscribeTokenSigner(signingKey),
    hasUnrecordedSchedule: (input: { actorUserId: string; date: string }) =>
      hasUnrecordedScheduledHabitsUseCase({ habitRepository, entryRepository }, input),
    random: Math.random,
    now: (() => new Date()) as Clock,
    appBaseUrl: requireValue(env.APP_BASE_URL, "APP_BASE_URL").replace(/\/+$/, ""),
  };
  return createDeliveryHandler({
    enabled: true,
    deliver: (deliveryId) => deliverReminderUseCase(deps, { deliveryId }),
    log,
  });
}

/** フィードバックは Feature Flag に関わらず記録する(送信を止めていても、送信済み分の bounce は受ける)。 */
async function buildFeedback(source: EnvSource) {
  const env = parseWorkerEnv(source);
  const prisma = await getPrisma(env);
  const deps = {
    deliveryRepository: createPrismaReminderDeliveryRepository(prisma),
    suppressions: createPrismaEmailSuppressionRepository(prisma),
    now: (() => new Date()) as Clock,
  };
  return createFeedbackHandler({
    handle: (event) => handleEmailFeedbackUseCase(deps, event),
    log: consoleLogger,
  });
}

function unreachable(): never {
  throw new Error("handler is disabled");
}

let scheduler: (() => ReturnType<typeof buildScheduler>) | undefined;
let delivery: (() => ReturnType<typeof buildDelivery>) | undefined;
let feedback: (() => ReturnType<typeof buildFeedback>) | undefined;

export function getScheduler(source: EnvSource = process.env) {
  scheduler ??= memoizeAsync(() => buildScheduler(source));
  return scheduler();
}

export function getDelivery(source: EnvSource = process.env) {
  delivery ??= memoizeAsync(() => buildDelivery(source));
  return delivery();
}

export function getFeedback(source: EnvSource = process.env) {
  feedback ??= memoizeAsync(() => buildFeedback(source));
  return feedback();
}
