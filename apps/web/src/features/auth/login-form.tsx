"use client";

import { useMutation } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { Button } from "@/components/button";
import { ErrorSummary, type ErrorSummaryItem } from "@/components/error-summary";
import { FormLinks, FormStack } from "@/components/form-layout";
import { StateMessage } from "@/components/state-message";
import { TextField } from "@/components/text-field";
import { signInWithPassword } from "@/lib/auth/auth-client";
import { describeFormError } from "@/lib/auth/form-errors";
import {
  LOGIN_FAILED_MESSAGE,
  SESSION_EXPIRED_MESSAGE,
  issueMessage,
  type AuthField,
} from "@/lib/auth/messages";
import { validateEmail, validatePassword } from "@/lib/auth/validation";

export interface LoginFormProps {
  /** server で検証済みの遷移先。 */
  readonly nextPath: string;
  readonly sessionExpired: boolean;
}

type FieldErrors = Partial<Record<AuthField, string>>;

export function LoginForm({ nextPath, sessionExpired }: LoginFormProps) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const mutation = useMutation({
    mutationFn: (input: { email: string; password: string }) => signInWithPassword(input),
    onSuccess: (result) => {
      setPassword("");
      if (result === "success") {
        router.replace(nextPath);
        return;
      }
      // 失敗の種類(不存在・不一致・未確認・lockout)は区別せず、常に同一の文言にする(AUI-INV-001)。
      setFormError(LOGIN_FAILED_MESSAGE);
      setAttempt((value) => value + 1);
    },
    onError: (error) => {
      setPassword("");
      setFormError(describeFormError(error, []).form);
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

  const summaryItems: ErrorSummaryItem[] = [
    ...(fieldErrors.email === undefined ? [] : [{ fieldId: "email", message: fieldErrors.email }]),
    ...(fieldErrors.password === undefined
      ? []
      : [{ fieldId: "password", message: fieldErrors.password }]),
    ...(formError === null ? [] : [{ message: formError }]),
  ];

  return (
    <>
      {sessionExpired ? (
        <StateMessage
          kind="empty"
          title="再ログインが必要です"
          description={SESSION_EXPIRED_MESSAGE}
        />
      ) : null}
      <form onSubmit={handleSubmit} noValidate aria-busy={mutation.isPending}>
        <FormStack>
          <ErrorSummary items={summaryItems} attempt={attempt} />
          {/* 失敗時の案内リンクは、アカウントの状態で出し分けず常に表示する(AUI-004)。 */}
          {formError === LOGIN_FAILED_MESSAGE ? (
            <p>
              確認メールが届いていない場合は<Link href="/verify-email">こちらから再送</Link>
              できます。
            </p>
          ) : null}
          <TextField
            id="email"
            name="email"
            label="メールアドレス"
            type="email"
            inputMode="email"
            autoComplete="username"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            error={fieldErrors.email}
          />
          <TextField
            id="password"
            name="password"
            label="パスワード"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            error={fieldErrors.password}
          />
          <div>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? "ログインしています" : "ログイン"}
            </Button>
          </div>
        </FormStack>
      </form>
      <FormLinks
        links={[
          { href: "/password-reset", label: "パスワードをお忘れの方" },
          { href: "/signup", label: "アカウントを作成" },
        ]}
      />
    </>
  );
}
