import { z } from "zod";

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    DATABASE_URL: z.string().url(),
    // Auth.js JWT署名鍵(docs/plans/auth-adapter.md Rollout and Operations、2026-09-22改訂)。
    AUTH_SECRET: z.string().min(32),
    // EmailSenderPortの実装選択。本番でsmtpは許可しない(認証メールのSES送信は未実装。T-402はリマインド通知のSES送信のみで、認証メールは別タスク)。
    AUTH_EMAIL_SENDER: z.enum(["smtp", "ses"]).default("smtp"),
    SMTP_HOST: z.string().default("localhost"),
    SMTP_PORT: z.coerce.number().int().positive().default(1025),
    EMAIL_FROM: z.string().default("no-reply@habit-app.local"),
    APP_BASE_URL: z.string().url().default("http://localhost:3000"),
    // メール内の配信停止 token の署名鍵(T-402)。配信停止 endpoint とリマインド送信でのみ必須とし、
    // 未設定でも他の機能は起動できる(使用する側が未設定を検査して失敗させる)。
    UNSUBSCRIBE_SIGNING_KEY: z.string().min(32).optional(),
  })
  .refine((value) => !(value.NODE_ENV === "production" && value.AUTH_EMAIL_SENDER === "smtp"), {
    message:
      "本番環境ではAUTH_EMAIL_SENDER=smtpを使用できません(docs/plans/auth-adapter.md Rollout and Operations参照)",
    path: ["AUTH_EMAIL_SENDER"],
  });

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
