import type { Metadata } from "next";

import { PageHeader } from "@/components/page-header";
import { ProfileForm } from "@/features/profile/profile-form";

export const metadata: Metadata = { title: "プロフィール" };

export default function ProfilePage() {
  return (
    <>
      <PageHeader title="プロフィール" />
      <ProfileForm mode="profile" supportedTimezones={Intl.supportedValuesOf("timeZone")} />
    </>
  );
}
