"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import Link from "next/link";

import { Button } from "@/components/button";
import { StateMessage } from "@/components/state-message";
import { ADMIN_QUERY_OPTIONS, adminAiJobsQueryKey, listAiJobFailures } from "@/lib/admin/admin-api";
import { formatUtc, statusLabel } from "@/lib/admin/format";

import { AdminErrorState } from "./admin-error-state";
import { FailureFilter } from "./failure-filter";
import styles from "./admin.module.css";

const OPTIONS = [
  { value: undefined, label: "すべて" },
  { value: "failed", label: "失敗" },
  { value: "fallback", label: "フォールバック" },
] as const;

export function AiJobFailures({ status }: { status: string | undefined }) {
  const query = useInfiniteQuery({
    queryKey: adminAiJobsQueryKey(status),
    queryFn: ({ pageParam, signal }) => listAiJobFailures(status, pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    ...ADMIN_QUERY_OPTIONS,
  });
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <>
      <FailureFilter basePath="/admin/ai-jobs" current={status} options={OPTIONS} />

      {query.isPending ? <StateMessage kind="loading" title="読み込んでいます" /> : null}
      {query.isError ? (
        <AdminErrorState
          error={query.error}
          title="一覧を読み込めませんでした"
          onRetry={() => void query.refetch()}
        />
      ) : null}
      {query.isSuccess && items.length === 0 ? (
        <StateMessage kind="empty" title="該当するジョブはありません" />
      ) : null}
      {items.length > 0 ? (
        <div
          className={styles["tableWrap"]}
          role="region"
          aria-label="AI ジョブの失敗の一覧"
          tabIndex={0}
        >
          <table className={styles["table"]}>
            <caption>新しい順に表示しています</caption>
            <thead>
              <tr>
                <th scope="col">ジョブ ID</th>
                <th scope="col">ユーザー</th>
                <th scope="col">種別</th>
                <th scope="col">状態</th>
                <th scope="col">失敗コード</th>
                <th scope="col">provider</th>
                <th scope="col">model</th>
                <th scope="col">prompt version</th>
                <th scope="col">作成日時</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.publicId}>
                  <th scope="row" className={styles["mono"]}>
                    {item.publicId}
                  </th>
                  <td>
                    <Link href={`/admin/users/${item.userPublicId}`} className={styles["mono"]}>
                      {item.userPublicId}
                    </Link>
                  </td>
                  <td>{item.kind}</td>
                  <td>{statusLabel(item.status)}</td>
                  <td>{item.failureCode ?? "なし"}</td>
                  <td>{item.provider}</td>
                  <td>{item.model}</td>
                  <td>{item.promptVersion}</td>
                  <td>{formatUtc(item.createdAt)}</td>
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
