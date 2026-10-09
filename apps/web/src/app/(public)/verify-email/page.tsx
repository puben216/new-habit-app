import type { Metadata } from "next";

import { PageHeader } from "@/components/page-header";
import { EmailRequestForm } from "@/features/auth/email-request-form";
import { VerifyEmailPanel } from "@/features/auth/verify-email-panel";
import { RESEND_DONE_MESSAGE } from "@/lib/auth/messages";

export const metadata: Metadata = { title: "メールアドレスの確認" };

interface VerifyEmailPageProps {
  readonly searchParams: Promise<{ token?: string | string[] }>;
}

export default async function VerifyEmailPage({ searchParams }: VerifyEmailPageProps) {
  const { token } = await searchParams;
  const tokenValue = typeof token === "string" ? token : "";

  if (tokenValue !== "") {
    return (
      <>
        <PageHeader title="メールアドレスの確認" />
        <VerifyEmailPanel token={tokenValue} />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="確認メールの再送"
        description="登録したメールアドレスに、確認メールをもう一度送ります。"
      />
      <EmailRequestForm
        path="/api/v1/auth/verify-email/resend"
        submitLabel="確認メールを再送する"
        pendingLabel="送信しています"
        doneTitle="確認メールを送信しました"
        doneMessage={RESEND_DONE_MESSAGE}
        links={[{ href: "/login", label: "ログインへ" }]}
      />
    </>
  );
}
