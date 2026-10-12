"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import Link from "next/link";

import { Button } from "@/components/button";
import { StateMessage } from "@/components/state-message";
import {
  ADMIN_QUERY_OPTIONS,
  adminNotificationsQueryKey,
  listNotificationFailures,
} from "@/lib/admin/admin-api";
import { formatUtc, statusLabel } from "@/lib/admin/format";

import { AdminErrorState } from "./admin-error-state";
import { FailureFilter } from "./failure-filter";
import styles from "./admin.module.css";

const OPTIONS = [
  { value: undefined, label: "すべて" },
  { value: "failed", label: "失敗" },
  { value: "expired", label: "期限切れ" },
  { value: "suppressed", label: "配信停止" },
] as const;

export function NotificationFailures({ status }: { status: string | undefined }) {
  const query = useInfiniteQuery({
    queryKey: adminNotificationsQueryKey(status),
    queryFn: ({ pageParam, signal }) => listNotificationFailures(status, pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    ...ADMIN_QUERY_OPTIONS,
  });
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <>
      <FailureFilter basePath="/admin/notifications" current={status} options={OPTIONS} />

      {query.isPending ? <StateMessage kind="loading" title="読み込んでいます" /> : null}
      {query.isError ? (
        <AdminErrorState
          error={query.error}
          title="一覧を読み込めませんでした"
          onRetry={() => void query.refetch()}
        />
      ) : null}
      {query.isSuccess && items.length === 0 ? (
        <StateMessage kind="empty" title="該当する配送はありません" />
      ) : null}
      {items.length > 0 ? (
        <div
          className={styles["tableWrap"]}
          role="region"
          aria-label="通知配送の失敗の一覧"
          tabIndex={0}
        >
          <table className={styles["table"]}>
            <caption>新しい順に表示しています</caption>
            <thead>
              <tr>
                <th scope="col">配送 ID</th>
                <th scope="col">ユーザー</th>
                <th scope="col">状態</th>
                <th scope="col">失敗コード</th>
                <th scope="col">試行回数</th>
                <th scope="col">予定日時</th>
                <th scope="col">現地日付</th>
                <th scope="col">更新日時</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <th scope="row">{item.id}</th>
                  <td>
                    <Link href={`/admin/users/${item.userPublicId}`} className={styles["mono"]}>
                      {item.userPublicId}
                    </Link>
                  </td>
                  <td>{statusLabel(item.status)}</td>
                  <td>{item.failureCode ?? "なし"}</td>
                  <td>{item.attemptCount}</td>
                  <td>{formatUtc(item.scheduledAt)}</td>
                  <td>{item.localDate}</td>
                  <td>{formatUtc(item.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {query.hasNextPage ? (
        <Button
          variant="secondary"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {query.isFetchingNextPage ? "読み込んでいます" : "さらに表示"}
        </Button>
      ) : null}
    </>
  );
}
