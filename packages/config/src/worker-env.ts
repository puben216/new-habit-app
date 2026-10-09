import { z } from "zod";

/**
 * Lambda(`apps/workers`)の環境変数(docs/specs/notification-delivery.md)。
 * Web 用の `parseEnv` とは別に検証する(workers は Auth.js や SMTP を使わないため)。
 *
 * secret の値は環境変数に直接置かず、Secrets Manager の ARN を渡して実行時に読む
 * (Terraform の state に secret の値を入れないため)。ローカル/テストでは値の直接指定も許可する。
 */
const booleanFlag = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const workerEnvSchema = z
  .object({
    /** false(既定)の間は scheduler と delivery は何もしない(Feature Flag)。 */
    NOTIFICATION_DELIVERY_ENABLED: booleanFlag,
    AWS_REGION: z.string().min(1),
    DATABASE_URL: z.string().url().optional(),
    DATABASE_URL_SECRET_ARN: z.string().min(1).optional(),
    UNSUBSCRIBE_SIGNING_KEY: z.string().min(32).optional(),
    UNSUBSCRIBE_SIGNING_KEY_SECRET_ARN: z.string().min(1).optional(),
    // 以下は役割ごとに必要なものだけが渡される(Lambda ごとの最小権限)。使う側(container)が必要な項目を検査する。
    /** delivery(メール本文のリンク・配信停止 URL)。 */
    APP_BASE_URL: z.string().url().optional(),
    /** delivery(送信元)。 */
    EMAIL_FROM: z.string().min(3).optional(),
    /** delivery(bounce/complaint を受ける configuration set)。 */
    SES_CONFIGURATION_SET: z.string().min(1).optional(),
    /** scheduler(投入先)。 */
    NOTIFICATION_QUEUE_URL: z.string().url().optional(),
    /** ai-coaching(AiCoachPort の実装。実 provider は ADR-003 の確定後に追加する。現在は fake のみ)。 */
    AI_PROVIDER: z.enum(["fake"]).default("fake"),
    /** ai-coaching(AI 提案の公開 Feature Flag)。false の間は provider を呼ばず定型 fallback で完結する。 */
    AI_PUBLICATION_ENABLED: booleanFlag,
  })
  .refine((v) => v.DATABASE_URL !== undefined || v.DATABASE_URL_SECRET_ARN !== undefined, {
    message: "DATABASE_URL か DATABASE_URL_SECRET_ARN のいずれかが必要です",
    path: ["DATABASE_URL"],
  });

/** 環境変数の読み取り元。`process.env` かテスト用のオブジェクト。 */
export type EnvSource = Readonly<Record<string, string | undefined>>;

export type WorkerEnv = z.infer<typeof workerEnvSchema>;

export const parseWorkerEnv = (source: EnvSource): WorkerEnv => {
  const result = workerEnvSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join(", ");
    throw new Error(`Invalid worker environment variables: ${issues}`);
  }
  return result.data;
};

/** 他の検証より先に Feature Flag だけを読む(無効なら、残りの設定が未投入でも起動できる)。 */
export const isNotificationDeliveryEnabled = (source: EnvSource): boolean =>
  source["NOTIFICATION_DELIVERY_ENABLED"] === "true";
