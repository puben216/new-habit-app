"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";

import { Button } from "@/components/button";
import { StateMessage } from "@/components/state-message";
import { buildAdminMfaPath } from "@/lib/admin/next-path";
import {
  NETWORK_MESSAGE,
  NOT_FOUND_MESSAGE,
  UNEXPECTED_MESSAGE,
  classifyAdminError,
} from "@/lib/admin/messages";

export interface AdminErrorStateProps {
  readonly error: unknown;
  /** 一覧・概要の取得失敗時の見出し(固定文言)。 */
  readonly title: string;
  readonly onRetry: () => void;
  /**
   * path の ID を受ける画面では、形式不正(`422`)も「存在しない対象」と同じ表示にする
   * (ID の形式から存在の有無を推測させないため。ADS-005)。
   */
  readonly invalidInputIsNotFound?: boolean;
}

/**
 * 管理画面の取得失敗の表示(ADS-008)。server の文言は使わず、status/code から固定の文言を選ぶ。
 * MFA の有効期限切れ(`403 mfa_required`)は、検証画面へ移る(元の path を `next` に載せる)。
 */
export function AdminErrorState({
  error,
  title,
  onRetry,
  invalidInputIsNotFound = false,
}: AdminErrorStateProps) {
  const router = useRouter();
  const pathname = usePathname();
  const kind = classifyAdminError(error);

  useEffect(() => {
    if (kind === "mfa_required") router.replace(buildAdminMfaPath(pathname));
  }, [kind, pathname, router]);

  if (kind === "mfa_required") {
    return <StateMessage kind="loading" title="確認コードの入力画面へ移動しています" />;
  }
  if (kind === "not_found" || (invalidInputIsNotFound && kind === "invalid_input")) {
    return <StateMessage kind="empty" title={NOT_FOUND_MESSAGE} />;
  }
  return (
    <StateMessage
      kind="error"
      title={title}
      description={kind === "network" ? NETWORK_MESSAGE : UNEXPECTED_MESSAGE}
      action={<Button onClick={onRetry}>もう一度試す</Button>}
    />
  );
}
