import type { Metadata } from "next";

import { PageHeader } from "@/components/page-header";
import { EmailRequestForm } from "@/features/auth/email-request-form";
import { PASSWORD_RESET_REQUESTED_MESSAGE } from "@/lib/auth/messages";

export const metadata: Metadata = { title: "パスワードの再設定" };

export default function PasswordResetPage() {
  return (
    <>
      <PageHeader
        title="パスワードの再設定"
        description="登録したメールアドレスに、再設定の案内を送ります。"
      />
      <EmailRequestForm
        path="/api/v1/auth/password-reset"
        submitLabel="案内を送る"
        pendingLabel="送信しています"
        doneTitle="案内を送信しました"
        doneMessage={PASSWORD_RESET_REQUESTED_MESSAGE}
        links={[{ href: "/login", label: "ログインへ戻る" }]}
      />
    </>
  );
}
