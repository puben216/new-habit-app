import type { Metadata } from "next";

import { PageHeader } from "@/components/page-header";
import { SignupForm } from "@/features/auth/signup-form";

export const metadata: Metadata = { title: "アカウント作成" };

export default function SignupPage() {
  return (
    <>
      <PageHeader title="アカウント作成" description="メールアドレスとパスワードで登録します。" />
      <SignupForm />
    </>
  );
}
