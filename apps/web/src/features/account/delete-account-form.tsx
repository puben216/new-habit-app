"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { Button } from "@/components/button";
import { ErrorSummary } from "@/components/error-summary";
import { FormStack } from "@/components/form-layout";
import { StateMessage } from "@/components/state-message";
import { TextField } from "@/components/text-field";
import { requestAccountDeletion } from "@/lib/account/account-api";
import {
  PASSWORD_REQUIRED_MESSAGE,
  accountErrorMessage,
  classifyAccountError,
} from "@/lib/account/messages";

import styles from "./account.module.css";

/**
 * アカウント削除の要求(docs/specs/account-deletion.md ACD-007)。パスワードは送信した時点で state から消し、
 * 成功・失敗にかかわらず残さない。確認は 2 段階(説明 → 確認 → 要求)。
 */
export function DeleteAccountForm() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [password, setPassword] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const mutation = useMutation({
    mutationFn: (value: string) => requestAccountDeletion(value),
    onSuccess: () => {
      // 全 session が失効している。前の状態を残さず、案内つきの login へ移る。
      queryClient.clear();
      router.replace("/login?reason=deletion_requested");
    },
    onError: (failure) => {
      setError(accountErrorMessage(classifyAccountError(failure)));
      setConfirming(false);
      setAttempt((value) => value + 1);
    },
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mutation.isPending) return;

    if (!confirming) {
      if (password.length === 0) {
        setError(PASSWORD_REQUIRED_MESSAGE);
        setAttempt((value) => value + 1);
        return;
      }
      setError(null);
      setConfirming(true);
      return;
    }

    const value = password;
    setPassword("");
    setError(null);
    mutation.mutate(value);
  }

  return (
    <form onSubmit={handleSubmit} noValidate aria-busy={mutation.isPending}>
      <FormStack>
        <ErrorSummary
          items={error === null ? [] : [{ fieldId: "delete-password", message: error }]}
          attempt={attempt}
        />
        <TextField
          id="delete-password"
          name="password"
          label="現在のパスワード"
          hint="本人確認のため、パスワードを入力してください。"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
            setConfirming(false);
          }}
          disabled={mutation.isPending}
        />
        {confirming ? (
          <StateMessage
            kind="empty"
            title="本当に削除を要求しますか"
            description="要求するとすべての端末からログアウトされます。30 日以内に再ログインすれば取り消せますが、期限を過ぎるとデータは完全に削除されます。"
          />
        ) : null}
        <div className={styles["actions"]}>
          <Button type="submit" disabled={mutation.isPending}>
            {mutation.isPending ? "要求しています" : confirming ? "削除を要求する" : "確認に進む"}
          </Button>
          {confirming ? (
            <Button variant="secondary" onClick={() => setConfirming(false)}>
              やめる
            </Button>
          ) : null}
        </div>
      </FormStack>
    </form>
  );
}
