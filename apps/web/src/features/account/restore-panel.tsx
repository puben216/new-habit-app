"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/button";
import { LogoutButton } from "@/components/logout-button";
import { StateMessage } from "@/components/state-message";
import {
  accountDeletionStatusQueryKey,
  cancelAccountDeletion,
  getAccountDeletionStatus,
} from "@/lib/account/account-api";
import { accountErrorMessage, classifyAccountError } from "@/lib/account/messages";
import { formatUtc } from "@/lib/format/utc";

import styles from "./account.module.css";

/** 削除予約中の取り消し(docs/specs/account-deletion.md ACD-004/005/007)。 */
export function RestorePanel() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const status = useQuery({
    queryKey: accountDeletionStatusQueryKey,
    queryFn: ({ signal }) => getAccountDeletionStatus(signal),
    gcTime: 0,
  });

  const cancel = useMutation({
    mutationFn: () => cancelAccountDeletion(),
    onSuccess: () => {
      setError(null);
      queryClient.clear();
      router.replace("/today");
      // Server Component のガードに、active に戻った状態を再評価させる。
      router.refresh();
    },
    onError: (failure) => setError(accountErrorMessage(classifyAccountError(failure))),
  });

  if (status.isPending) return <StateMessage kind="loading" title="読み込んでいます" />;
  if (status.isError) {
    return (
      <StateMessage
        kind="error"
        title="状態を読み込めませんでした"
        description="時間をおいてもう一度お試しください。"
        action={<Button onClick={() => void status.refetch()}>もう一度試す</Button>}
      />
    );
  }

  if (status.data.status === "active") {
    // 取り消し済み(別の画面で取り消した場合など)。通常の画面へ戻る。
    return (
      <StateMessage
        kind="empty"
        title="削除は予約されていません"
        action={<Button onClick={() => router.replace("/today")}>今日の画面へ</Button>}
      />
    );
  }

  return (
    <>
      <p>
        このアカウントは削除が予約されています。
        <strong>{formatUtc(status.data.scheduledFor ?? "")}</strong>
        を過ぎると、データは完全に削除され、元に戻せません。それまでは削除を取り消せます。
      </p>
      {error === null ? null : (
        <div role="alert" className={styles["error"]}>
          <span aria-hidden="true">エラー: </span>
          {error}
        </div>
      )}
      <div className={styles["actions"]}>
        <Button disabled={cancel.isPending} onClick={() => cancel.mutate()}>
          {cancel.isPending ? "取り消しています" : "削除を取り消す"}
        </Button>
        <LogoutButton />
      </div>
    </>
  );
}
