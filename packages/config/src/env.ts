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
