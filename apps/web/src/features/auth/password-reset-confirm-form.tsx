"use client";

import { useMutation } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";

import { Button } from "@/components/button";
import { ErrorSummary, type ErrorSummaryItem } from "@/components/error-summary";
import { FormLinks, FormStack } from "@/components/form-layout";
import { StateMessage } from "@/components/state-message";
import { TextField } from "@/components/text-field";
import { apiRequest } from "@/lib/api/client";
import { describeFormError, isInvalidTokenError } from "@/lib/auth/form-errors";
import { INVALID_LINK_MESSAGE, issueMessage } from "@/lib/auth/messages";
import { acknowledgedSchema } from "@/lib/auth/schemas";
import { validatePassword, validateToken } from "@/lib/auth/validation";

import { stripQueryFromUrl } from "./token-action";

const REREQUEST_LINKS = [{ href: "/password-reset", label: "再設定の案内をもう一度送る" }];

export function PasswordResetConfirmForm({ token }: { token: string }) {
  const [password, setPassword] = useState("");
  const [passwordError, setPasswordError] = useState<string | undefined>(undefined);
  const [formError, setFormError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const mutation = useMutation({
    mutationFn: (newPassword: string) =>
      apiRequest({
        method: "POST",
        path: "/api/v1/auth/password-reset/confirm",
        schema: acknowledgedSchema,
        body: { token, newPassword },
      }),
    onSuccess: () => {
      setPassword("");
      stripQueryFromUrl();
    },
    onError: (error) => {
      setPassword("");
      if (isInvalidTokenError(error)) {
        stripQueryFromUrl();
        return;
      }
      const described = describeFormError(error, ["newPassword"]);
      setPasswordError(described.fields.newPassword);
      setFormError(described.form);
      setAttempt((value) => value + 1);
    },
  });

  if (validateToken(token) !== null || (mutation.isError && isInvalidTokenError(mutation.error))) {
    return (
      <>
        <StateMessage kind="error" title="再設定できません" description={INVALID_LINK_MESSAGE} />
        <FormLinks links={REREQUEST_LINKS} />
      </>
    );
  }

  if (mutation.isSuccess) {
    return (
      <>
        <StateMessage
          kind="empty"
          title="パスワードを再設定しました"
          description="新しいパスワードでログインしてください。"
        />
        <FormLinks links={[{ href: "/login", label: "ログインへ" }]} />
      </>
    );
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mutation.isPending) return;

    const issue = validatePassword(password);
    setFormError(null);
    if (issue !== null) {
      setPasswordError(issueMessage("newPassword", issue));
      setAttempt((value) => value + 1);
      return;
    }
    setPasswordError(undefined);
    mutation.mutate(password);
  }

  const summaryItems: ErrorSummaryItem[] = [
    ...(passwordError === undefined ? [] : [{ fieldId: "newPassword", message: passwordError }]),
    ...(formError === null ? [] : [{ message: formError }]),
  ];

  return (
    <form onSubmit={handleSubmit} noValidate aria-busy={mutation.isPending}>
      <FormStack>
        <ErrorSummary items={summaryItems} attempt={attempt} />
        <TextField
          id="newPassword"
          name="newPassword"
          label="新しいパスワード"
          hint="8文字以上128文字以内"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          error={passwordError}
        />
        <div>
          <Button type="submit" disabled={mutation.isPending}>
            {mutation.isPending ? "送信しています" : "パスワードを再設定"}
          </Button>
        </div>
      </FormStack>
    </form>
  );
}
