"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";

import { StateMessage } from "@/components/state-message";
import { ADMIN_QUERY_OPTIONS, adminUserQueryKey, getAdminUser } from "@/lib/admin/admin-api";
import { formatUtc, sortedCounts, statusLabel } from "@/lib/admin/format";

import { AdminErrorState } from "./admin-error-state";
import styles from "./admin.module.css";

function Counts({
  counts,
  emptyText,
}: {
  counts: Readonly<Record<string, number>>;
  emptyText: string;
}) {
  const entries = sortedCounts(counts);
  if (entries.length === 0) return <p className={styles["note"]}>{emptyText}</p>;
  return (
    <ul className={styles["counts"]}>
      {entries.map(([status, count]) => (
        <li key={status}>
          {statusLabel(status)}: {count} 件
        </li>
      ))}
    </ul>
  );
}

export function UserOverview({ publicId }: { publicId: string }) {
  const query = useQuery({
    queryKey: adminUserQueryKey(publicId),
    queryFn: ({ signal }) => getAdminUser(publicId, signal),
    ...ADMIN_QUERY_OPTIONS,
  });

  if (query.isPending) return <StateMessage kind="loading" title="読み込んでいます" />;
  if (query.isError) {
    return (
      <>
        <AdminErrorState
          error={query.error}
          title="概要を読み込めませんでした"
          onRetry={() => void query.refetch()}
          invalidInputIsNotFound
        />
        <p>
          <Link href="/admin/users">ユーザー検索へ戻る</Link>
        </p>
      </>
    );
  }

  const user = query.data;
  return (
    <>
      <dl className={styles["definitions"]}>
        <dt>メールアドレス</dt>
        <dd>{user.emailMasked}</dd>
        <dt>状態</dt>
        <dd>{statusLabel(user.status)}</dd>
        <dt>登録日時</dt>
        <dd>{formatUtc(user.createdAt)}</dd>
        <dt>メール確認</dt>
        <dd>{user.emailVerified ? "確認済み" : "未確認"}</dd>
        <dt>公開 ID</dt>
        <dd className={styles["mono"]}>{user.publicId}</dd>
      </dl>

      <section aria-labelledby="notification-heading" className={styles["section"]}>
        <h2 id="notification-heading">通知(直近 30 日)</h2>
        <p>配信の抑止(バウンス・苦情など): {user.notification.suppressed ? "あり" : "なし"}</p>
        <Counts counts={user.notification.deliveries} emptyText="配信の記録はありません。" />
      </section>

      <section aria-labelledby="ai-heading" className={styles["section"]}>
        <h2 id="ai-heading">AI ジョブ(直近 30 日)</h2>
        <Counts counts={user.aiJobs} emptyText="ジョブの記録はありません。" />
      </section>

      <p>
        <Link href="/admin/users">ユーザー検索へ戻る</Link>
      </p>
    </>
  );
}
