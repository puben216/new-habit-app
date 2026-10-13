import type { Metadata } from "next";
import Link from "next/link";

import { PageHeader } from "@/components/page-header";
import { ExportPanel } from "@/features/account/export-panel";

export const metadata: Metadata = { title: "データのエクスポート" };

export default function ExportPage() {
  return (
    <>
      <PageHeader title="データのエクスポート" />
      <p>自分のデータを、JSON または CSV のファイルとして取り出せます。</p>
      <h2>含まれるデータ</h2>
      <ul>
        <li>アカウント(メールアドレス)、プロフィール</li>
        <li>習慣とスケジュール、実行の記録、デイリーチェックイン</li>
        <li>週次レビュー、通知設定、AI の結果</li>
      </ul>
      <p>パスワードやログインの情報、監査の記録は含まれません。</p>
      <p>
        ファイルは作成に少し時間がかかります。完成してから <strong>24 時間</strong>
        だけダウンロードでき、その後は削除されます。本人確認のため、作成のたびにパスワードが必要です。
      </p>
      <ExportPanel />
      <p>
        <Link href="/profile">プロフィールへ戻る</Link>
      </p>
    </>
  );
}
