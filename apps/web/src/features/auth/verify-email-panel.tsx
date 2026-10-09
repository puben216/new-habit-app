"use client";

import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "@/components/button";
import { FormLinks } from "@/components/form-layout";
import { StateMessage } from "@/components/state-message";
import { apiRequest } from "@/lib/api/client";
import { describeFormError, isInvalidTokenError } from "@/lib/auth/form-errors";
import { INVALID_LINK_MESSAGE } from "@/lib/auth/messages";
import { acknowledgedSchema } from "@/lib/auth/schemas";
import { validateToken } from "@/lib/auth/validation";

import { stripQueryFromUrl } from "./token-action";

/**
 * メールのリンクから開く確認画面。ボタンを押すまで token を消費しない
 * (リンクの先読みで単回使用の token が失われるのを避ける)。
 */
export function VerifyEmailPanel({ token }: { token: string }) {
  const [clientError, setClientError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      apiRequest({
        method: "POST",
        path: "/api/v1/auth/verify-email",
        schema: acknowledgedSchema,
        body: { token },
      }),
    onSettled: () => stripQueryFromUrl(),
  });

  if (mutation.isSuccess) {
    return (
      <>
        <StateMessage
          kind="empty"
          headingLevel={2}
          title="メールアドレスを確認しました"
          description="ログインしてご利用ください。"
        />
        <FormLinks links={[{ href: "/login", label: "ログインへ" }]} />
      </>
    );
  }

  if (mutation.isError && isInvalidTokenError(mutation.error)) {
    return (
      <>
        <StateMessage
          kind="error"
          title="確認できませんでした"
          description={INVALID_LINK_MESSAGE}
        />
        <FormLinks
          links={[
            { href: "/verify-email", label: "確認メールを再送する" },
            { href: "/login", label: "ログインへ" },
          ]}
        />
      </>
    );
  }

  const errorMessage =
    clientError ?? (mutation.isError ? describeFormError(mutation.error, []).form : null);

  return (
    <>
      {errorMessage === null ? null : (
        <StateMessage kind="error" title="確認できませんでした" description={errorMessage} />
      )}
      <p>下のボタンを押すと、メールアドレスの確認が完了します。</p>
      <Button
        disabled={mutation.isPending}
        onClick={() => {
          if (mutation.isPending) return;
          if (validateToken(token) !== null) {
            setClientError(INVALID_LINK_MESSAGE);
            return;
          }
          setClientError(null);
          mutation.mutate();
        }}
      >
        {mutation.isPending ? "確認しています" : "メールアドレスを確認する"}
      </Button>
    </>
  );
}
