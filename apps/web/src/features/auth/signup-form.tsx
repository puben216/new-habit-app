"use client";

import { useMutation } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";

import { Button } from "@/components/button";
import { ErrorSummary, type ErrorSummaryItem } from "@/components/error-summary";
import { FormLinks, FormStack } from "@/components/form-layout";
import { StateMessage } from "@/components/state-message";
import { TextField } from "@/components/text-field";
import { apiRequest } from "@/lib/api/client";
import { describeFormError } from "@/lib/auth/form-errors";
import { SIGNUP_DONE_MESSAGE, issueMessage, type AuthField } from "@/lib/auth/messages";
import { acknowledgedSchema } from "@/lib/auth/schemas";
import { validateEmail, validatePassword } from "@/lib/auth/validation";

type FieldErrors = Partial<Record<AuthField, string>>;

const FIELDS: readonly AuthField[] = ["email", "password"];

export function SignupForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const mutation = useMutation({
    mutationFn: (body: { email: string; password: string }) =>
      apiRequest({
        method: "POST",
        path: "/api/v1/auth/signup",
        schema: acknowledgedSchema,
        body,
      }),
    onSuccess: () => {
      setPassword("");
    },
    onError: (error) => {
      const described = describeFormError(error, FIELDS);
      setFieldErrors(described.fields);
      setFormError(described.form);
      setPassword("");
      setAttempt((value) => value + 1);
    },
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mutation.isPending) return;

    const emailIssue = validateEmail(email);
    const passwordIssue = validatePassword(password);
    const nextErrors: FieldErrors = {
      ...(emailIssue === null ? {} : { email: issueMessage("email", emailIssue) }),
      ...(passwordIssue === null ? {} : { password: issueMessage("password", passwordIssue) }),
    };
    setFieldErrors(nextErrors);
    setFormError(null);
    if (Object.keys(nextErrors).length > 0) {
      setAttempt((value) => value + 1);
      return;
    }
    mutation.mutate({ email: email.trim(), password });
  }

  if (mutation.isSuccess) {
    return (
      <>
        <StateMessage
          kind="empty"
          title="確認メールを送信しました"
          description={SIGNUP_DONE_MESSAGE}
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

  const summaryItems: ErrorSummaryItem[] = [
    ...(fieldErrors.email === undefined ? [] : [{ fieldId: "email", message: fieldErrors.email }]),
    ...(fieldErrors.password === undefined
      ? []
      : [{ fieldId: "password", message: fieldErrors.password }]),
    ...(formError === null ? [] : [{ message: formError }]),
  ];

  return (
    <>
      <form onSubmit={handleSubmit} noValidate aria-busy={mutation.isPending}>
        <FormStack>
          <ErrorSummary items={summaryItems} attempt={attempt} />
          <TextField
            id="email"
            name="email"
            label="メールアドレス"
            type="email"
            inputMode="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            error={fieldErrors.email}
          />
          <TextField
            id="password"
            name="password"
            label="パスワード"
            hint="8文字以上128文字以内"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            error={fieldErrors.password}
          />
          <div>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? "送信しています" : "アカウントを作成"}
            </Button>
          </div>
        </FormStack>
      </form>
      <FormLinks links={[{ href: "/login", label: "アカウントをお持ちの方はログイン" }]} />
    </>
  );
}
