import type { EmailSenderPort } from "@habit-app/application";

export interface SentEmail {
  readonly to: string;
  readonly token: string;
}

/**
 * Unit/Integration Test 用の EmailSenderPort 実装(Plan: InMemoryEmailSender)。
 * プロセス内メモリに保持し、テストコードから直接参照する。DB・ログのいずれにも書き込まない。
 * Application 層の test-fakes.ts にある FakeEmailSender とは別物(そちらは use case 単体の
 * Unit Test 専用で、こちらは Infrastructure を含む Integration Test で実際の DI 構成に差し込む)。
 */
export interface InMemoryEmailSender extends EmailSenderPort {
  readonly sentVerificationEmails: ReadonlyArray<SentEmail>;
  readonly sentPasswordResetEmails: ReadonlyArray<SentEmail>;
}

export function createInMemoryEmailSender(): InMemoryEmailSender {
  const sentVerificationEmails: SentEmail[] = [];
  const sentPasswordResetEmails: SentEmail[] = [];

  return {
    sentVerificationEmails,
    sentPasswordResetEmails,
    async sendVerificationEmail(to: string, token: string): Promise<void> {
      sentVerificationEmails.push({ to, token });
    },
    async sendPasswordResetEmail(to: string, token: string): Promise<void> {
      sentPasswordResetEmails.push({ to, token });
    },
  };
}
