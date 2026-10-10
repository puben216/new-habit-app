"use client";

import { useMutation } from "@tanstack/react-query";
import Link from "next/link";
import { useState, type FormEvent } from "react";

import { Button } from "@/components/button";
import { ErrorSummary } from "@/components/error-summary";
import { FormStack } from "@/components/form-layout";
import { StateMessage } from "@/components/state-message";
import { TextField } from "@/components/text-field";
import { searchUsers } from "@/lib/admin/admin-api";
import { formatUtc, statusLabel } from "@/lib/admin/format";
import { EMAIL_INVALID_MESSAGE, classifyAdminError } from "@/lib/admin/messages";
import { validateEmail } from "@/lib/auth/validation";

import { AdminErrorState } from "./admin-error-state";
import styles from "./admin.module.css";

/**
 * ユーザー検索(docs/specs/admin-screens.md ADS-004)。email は component の state にだけ持ち、
 * URL・storage・queryKey に載せない(ADS-INV-003)ため、取得は `useMutation` で行う。
 */
export function UserSearch() {
  const [email, setEmail] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const mutation = useMutation({
    mutationFn: (value: string) => searchUsers(value),
    onError: (failure) => {
      if (classifyAdminError(failure) === "invalid_input") {
        setFieldError(EMAIL_INVALID_MESSAGE);
        setAttempt((value) => value + 1);
      }
    },
    // 結果(マスク済み email)をブラウザの cache に残さない。
    gcTime: 0,
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mutation.isPending) return;

    if (validateEmail(email) !== null) {
      mutation.reset();
      setFieldError(EMAIL_INVALID_MESSAGE);
      setAttempt((value) => value + 1);
      return;
    }
    setFieldError(null);
    mutation.mutate(email.trim());
  }

  const failure = mutation.isError && classifyAdminError(mutation.error) !== "invalid_input";

  return (
    <>
      <form onSubmit={handleSubmit} noValidate aria-busy={mutation.isPending}>
        <FormStack>
          <ErrorSummary
            items={fieldError === null ? [] : [{ fieldId: "search-email", message: fieldError }]}
            attempt={attempt}
          />
          <TextField
            id="search-email"
            name="email"
            label="メールアドレス"
            type="email"
            inputMode="email"
            autoComplete="off"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            error={fieldError ?? undefined}
          />
          <div>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? "検索しています" : "検索"}
            </Button>
          </div>
        </FormStack>
      </form>

      {failure ? (
        <AdminErrorState
          error={mutation.error}
          title="検索できませんでした"
          onRetry={() => mutation.mutate(email.trim())}
        />
      ) : null}

      {mutation.isSuccess ? (
        <section aria-labelledby="search-result-heading" className={styles["section"]}>
          <h2 id="search-result-heading">検索結果</h2>
          <p role="status">
            {mutation.data.items.length === 0
              ? "該当するユーザーは見つかりませんでした。"
              : `${mutation.data.items.length} 件見つかりました。`}
          </p>
          {mutation.data.items.length > 0 ? (
            <div className={styles["tableWrap"]}>
              <table className={styles["table"]}>
                <caption>検索結果(メールアドレスは一部を伏せて表示しています)</caption>
                <thead>
                  <tr>
                    <th scope="col">メールアドレス</th>
                    <th scope="col">状態</th>
                    <th scope="col">登録日時</th>
                    <th scope="col">詳細</th>
                  </tr>
                </thead>
                <tbody>
                  {mutation.data.items.map((item) => (
                    <tr key={item.publicId}>
                      <td>{item.emailMasked}</td>
                      <td>{statusLabel(item.status)}</td>
                      <td>{formatUtc(item.createdAt)}</td>
                      <td>
                        <Link href={`/admin/users/${item.publicId}`}>概要を見る</Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>
      ) : null}
      {mutation.isIdle ? (
        <StateMessage kind="empty" title="メールアドレスを入力して検索してください" />
      ) : null}
    </>
  );
}
