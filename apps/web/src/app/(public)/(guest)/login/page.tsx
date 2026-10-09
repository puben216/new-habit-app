import type { Metadata } from "next";

import { PageHeader } from "@/components/page-header";
import { LoginForm } from "@/features/auth/login-form";
import { SESSION_EXPIRED_REASON, sanitizeNextPath } from "@/lib/auth/next-path";

export const metadata: Metadata = { title: "ログイン" };

interface LoginPageProps {
  readonly searchParams: Promise<{ next?: string | string[]; reason?: string | string[] }>;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const { next, reason } = await searchParams;

  return (
    <>
      <PageHeader title="ログイン" />
      <LoginForm
        nextPath={sanitizeNextPath(next)}
        sessionExpired={reason === SESSION_EXPIRED_REASON}
      />
    </>
  );
}
