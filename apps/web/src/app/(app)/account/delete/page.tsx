import type { Metadata } from "next";
import Link from "next/link";

import { PageHeader } from "@/components/page-header";
import { DeleteAccountForm } from "@/features/account/delete-account-form";

export const metadata: Metadata = { title: "アカウントの削除" };

export default function DeleteAccountPage() {
  return (
    <>
      <PageHeader title="アカウントの削除" />
      <p>アカウントを削除すると、次のデータがすべて削除されます。</p>
      <ul>
        <li>プロフィール、習慣、実行の記録、デイリーチェックイン</li>
        <li>週次レビュー、AI の提案、通知の設定と履歴</li>
      </ul>
      <p>
        削除を要求すると、すべての端末からログアウトされ、通知も送られなくなります。
        <strong>30 日の猶予</strong>
        があり、その間に同じメールアドレスとパスワードで再ログインすると、削除を取り消せます。猶予を過ぎるとデータは完全に削除され、元に戻せません。
      </p>
      <DeleteAccountForm />
      <p>
        <Link href="/profile">プロフィールへ戻る</Link>
      </p>
    </>
  );
}
