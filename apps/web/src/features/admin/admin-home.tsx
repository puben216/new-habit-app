"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";

import { StateMessage } from "@/components/state-message";
import { ADMIN_QUERY_OPTIONS, adminMeQueryKey, getAdminMe } from "@/lib/admin/admin-api";
import { formatUtc } from "@/lib/admin/format";

import { AdminErrorState } from "./admin-error-state";
import styles from "./admin.module.css";

const TOOLS = [
  {
    href: "/admin/users",
    label: "ユーザー検索",
    description: "メールアドレスの完全一致で検索し、概要を確認します。",
  },
  {
    href: "/admin/notifications",
    label: "通知配送の失敗",
    description: "失敗・期限切れ・配信停止の配送を確認します。",
  },
  {
    href: "/admin/ai-jobs",
    label: "AI ジョブの失敗",
    description: "失敗・フォールバックのジョブを確認します。",
  },
] as const;

export function AdminHome() {
  const query = useQuery({
    queryKey: adminMeQueryKey,
    queryFn: ({ signal }) => getAdminMe(signal),
    ...ADMIN_QUERY_OPTIONS,
  });

  if (query.isPending) return <StateMessage kind="loading" title="読み込んでいます" />;
  if (query.isError) {
    return (
      <AdminErrorState
        error={query.error}
        title="状態を読み込めませんでした"
        onRetry={() => void query.refetch()}
      />
    );
  }

  return (
    <>
      <p className={styles["note"]}>
        {query.data.mfaExpiresAt === null
          ? "確認コードが未検証です。"
          : `確認コードの有効期限: ${formatUtc(query.data.mfaExpiresAt)}(期限後は再度の確認が必要です)`}
      </p>
      <ul className={styles["links"]}>
        {TOOLS.map((tool) => (
          <li key={tool.href}>
            <Link href={tool.href}>{tool.label}</Link>
            <span className={styles["note"]}> — {tool.description}</span>
          </li>
        ))}
      </ul>
    </>
  );
}
