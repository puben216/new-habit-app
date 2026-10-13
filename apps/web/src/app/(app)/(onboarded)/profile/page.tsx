import type { Metadata } from "next";

import Link from "next/link";

import { PageHeader } from "@/components/page-header";
import { ProfileForm } from "@/features/profile/profile-form";

import styles from "./profile-page.module.css";

export const metadata: Metadata = { title: "プロフィール" };

export default function ProfilePage() {
  return (
    <>
      <PageHeader title="プロフィール" />
      <ProfileForm mode="profile" supportedTimezones={Intl.supportedValuesOf("timeZone")} />
      <section aria-labelledby="account-heading" className={styles["account"]}>
        <h2 id="account-heading">アカウント</h2>
        <p>
          自分のデータの取り出し(エクスポート)と、アカウントとデータの削除の要求ができます。削除は
          30 日以内であれば取り消せます。
        </p>
        <ul>
          <li>
            <Link href="/account/export">データをエクスポートする</Link>
          </li>
          <li>
            <Link href="/account/delete">アカウントを削除する</Link>
          </li>
        </ul>
      </section>
    </>
  );
}
