import type { Metadata } from "next";

import { PageHeader } from "@/components/page-header";
import { ProfileForm } from "@/features/profile/profile-form";
import { requireNotOnboarded } from "@/server/require-onboarding";

export const metadata: Metadata = { title: "はじめての設定" };

export default async function OnboardingPage() {
  await requireNotOnboarded();

  return (
    <>
      <PageHeader
        title="はじめての設定"
        description="表示名とタイムゾーンを設定します。あとからプロフィールで変更できます。"
      />
      <ProfileForm mode="onboarding" supportedTimezones={Intl.supportedValuesOf("timeZone")} />
    </>
  );
}
