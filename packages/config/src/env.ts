import { z } from "zod";

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    DATABASE_URL: z.string().url(),
    // Auth.js JWT署名鍵(docs/plans/auth-adapter.md Rollout and Operations、2026-09-22改訂)。
    AUTH_SECRET: z.string().min(32),
    // EmailSenderPortの実装選択。本番でsmtpは許可しない(SesEmailSenderはT-401で実装)。
    AUTH_EMAIL_SENDER: z.enum(["smtp", "ses"]).default("smtp"),
    SMTP_HOST: z.string().default("localhost"),
    SMTP_PORT: z.coerce.number().int().positive().default(1025),
    EMAIL_FROM: z.string().default("no-reply@habit-app.local"),
    APP_BASE_URL: z.string().url().default("http://localhost:3000"),
    // AI job の queue(docs/specs/ai-queue-pipeline.md)。inline は同一プロセスで処理するローカル/E2E 専用。
    // sqs の adapter は T-501 で実装する。
    AI_QUEUE_DRIVER: z.enum(["inline", "sqs"]).default("inline"),
    // AiCoachPort の実装。実 provider は ADR-003 の確定後に追加する(現在は fake のみ)。
    AI_PROVIDER: z.enum(["fake"]).default("fake"),
    // AI 提案の公開 feature flag。false の間は provider を呼ばず定型 fallback で完結する。
    AI_PUBLICATION_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
  })
  .refine((value) => !(value.NODE_ENV === "production" && value.AUTH_EMAIL_SENDER === "smtp"), {
    message:
      "本番環境ではAUTH_EMAIL_SENDER=smtpを使用できません(docs/plans/auth-adapter.md Rollout and Operations参照)",
    path: ["AUTH_EMAIL_SENDER"],
  })
  .refine((value) => !(value.NODE_ENV === "production" && value.AI_QUEUE_DRIVER === "inline"), {
    message: "本番環境ではAI_QUEUE_DRIVER=inlineを使用できません(docs/specs/ai-queue-pipeline.md)",
    path: ["AI_QUEUE_DRIVER"],
  })
  .refine(
    (value) =>
      !(
        value.NODE_ENV === "production" &&
        value.AI_PUBLICATION_ENABLED &&
        value.AI_PROVIDER === "fake"
      ),
    {
      message:
        "本番環境でAI_PUBLICATION_ENABLED=trueにするには、fake以外のAI_PROVIDERが必要です(ADR-003)",
      path: ["AI_PROVIDER"],
    },
  );

export type Env = z.infer<typeof envSchema>;

export const parseEnv = (source: NodeJS.ProcessEnv): Env => {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join(", ");
    throw new Error(`Invalid environment variables: ${issues}`);
  }
  return result.data;
};

/**
 * worker(Lambda)用の環境変数。web と違い認証・メール・URL の設定を必要としない
 * (不要な Secret を worker に渡さないため。docs/specs/ai-queue-pipeline.md)。
 */
const workerEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().url(),
  AI_PROVIDER: z.enum(["fake"]).default("fake"),
  AI_PUBLICATION_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
});

export type WorkerEnv = z.infer<typeof workerEnvSchema>;

export const parseWorkerEnv = (source: NodeJS.ProcessEnv): WorkerEnv => {
  const result = workerEnvSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join(", ");
    throw new Error(`Invalid environment variables: ${issues}`);
  }
  if (
    result.data.NODE_ENV === "production" &&
    result.data.AI_PUBLICATION_ENABLED &&
    result.data.AI_PROVIDER === "fake"
  ) {
    throw new Error(
      "Invalid environment variables: AI_PROVIDER: 本番環境でAI_PUBLICATION_ENABLED=trueにするには、fake以外のAI_PROVIDERが必要です(ADR-003)",
    );
  }
  return result.data;
};
