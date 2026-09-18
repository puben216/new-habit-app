import nodemailer from "nodemailer";
import type { EmailSenderPort } from "@habit-app/application";

export interface SmtpEmailSenderOptions {
  readonly host: string;
  readonly port: number;
  readonly from: string;
  /** verification token を付与するリンクのベース URL(例: "https://app.example.com/verify-email")。 */
  readonly verificationUrlBase: string;
  /** password reset token を付与するリンクのベース URL(例: "https://app.example.com/password-reset/confirm")。 */
  readonly passwordResetUrlBase: string;
}

/**
 * EmailSenderPort 実装(Plan: SmtpEmailSender)。dev/E2E 用に SMTP でメールを送信する。
 * 本番では使わない(本番デプロイ設定は `AUTH_EMAIL_SENDER=smtp` を許可しない、Plan Rollout and Operations 参照)。
 */
export function createSmtpEmailSender(options: SmtpEmailSenderOptions): EmailSenderPort {
  const transporter = nodemailer.createTransport({
    host: options.host,
    port: options.port,
    secure: false,
  });

  function buildUrl(base: string, token: string): string {
    return `${base}?token=${encodeURIComponent(token)}`;
  }

  return {
    async sendVerificationEmail(to: string, token: string): Promise<void> {
      const url = buildUrl(options.verificationUrlBase, token);
      await transporter.sendMail({
        from: options.from,
        to,
        subject: "メールアドレスの確認",
        text: `以下のリンクからメールアドレスを確認してください。\n\n${url}`,
      });
    },
    async sendPasswordResetEmail(to: string, token: string): Promise<void> {
      const url = buildUrl(options.passwordResetUrlBase, token);
      await transporter.sendMail({
        from: options.from,
        to,
        subject: "パスワードの再設定",
        text: `以下のリンクからパスワードを再設定してください。\n\n${url}`,
      });
    },
  };
}
