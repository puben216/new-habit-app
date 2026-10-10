import { z } from "zod";

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    DATABASE_URL: z.string().url(),
    // Auth.js JWT署名鍵(docs/plans/auth-adapter.md Rollout and Operations、2026-09-22改訂)。
    AUTH_SECRET: z.string().min(32),
    // EmailSenderPortの実装選択。本番でsmtpは許可しない(認証メールのSES送信は未実装。T-402はリマインド通知のSES送信のみで、認証メールはT-405)。
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
    // メール内の配信停止 token の署名鍵(T-402)。配信停止 endpoint とリマインド送信でのみ必須とし、
    // 未設定でも他の機能は起動できる(使用する側が未設定を検査して失敗させる)。
    UNSUBSCRIBE_SIGNING_KEY: z.string().min(32).optional(),
    // 管理機能(T-403)。TOTP 秘密の暗号鍵(32 バイトを base64。形式は使う側が検証する)と、
    // 監査ログに残す IP の HMAC 鍵。未設定でも他の機能は起動できる(管理 API は使うときに検査して失敗する)。
    ADMIN_TOTP_ENCRYPTION_KEY: z.string().min(1).optional(),
    AUDIT_IP_HASH_KEY: z.string().min(32).optional(),
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
