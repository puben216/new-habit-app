import type { Metadata } from "next";

import { PageHeader } from "@/components/page-header";
import { PasswordResetConfirmForm } from "@/features/auth/password-reset-confirm-form";

export const metadata: Metadata = { title: "新しいパスワードの設定" };

interface PasswordResetConfirmPageProps {
  readonly searchParams: Promise<{ token?: string | string[] }>;
}

export default async function PasswordResetConfirmPage({
  searchParams,
}: PasswordResetConfirmPageProps) {
  const { token } = await searchParams;

  return (
    <>
      <PageHeader title="新しいパスワードの設定" />
      <PasswordResetConfirmForm token={typeof token === "string" ? token : ""} />
    </>
  );
}
