"use client";

import { useMutation } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";

import { Button } from "@/components/button";
import { ErrorSummary, type ErrorSummaryItem } from "@/components/error-summary";
import { FormLinks, FormStack, type FormLink } from "@/components/form-layout";
import { StateMessage } from "@/components/state-message";
import { TextField } from "@/components/text-field";
import { apiRequest } from "@/lib/api/client";
import { describeFormError } from "@/lib/auth/form-errors";
import { issueMessage } from "@/lib/auth/messages";
import { acknowledgedSchema } from "@/lib/auth/schemas";
import { validateEmail } from "@/lib/auth/validation";

export interface EmailRequestFormProps {
  /** `POST` 先(`/api/v1/auth/verify-email/resend` または `/api/v1/auth/password-reset`)。 */
  readonly path: string;
  readonly submitLabel: string;
  readonly pendingLabel: string;
  /** 完了表示の見出しと本文(アカウントの有無に依らない固定文言)。 */
  readonly doneTitle: string;
  readonly doneMessage: string;
  readonly links: readonly FormLink[];
}

/**
 * email だけを送る要求フォーム(確認メールの再送、パスワード再設定の要求)。
 * 応答は常に `202` で、登録の有無によらず同一の完了表示にする(AUI-INV-001)。
 */
export function EmailRequestForm(props: EmailRequestFormProps) {
  const [email, setEmail] = useState("");
  const [emailError, setEmailError] = useState<string | undefined>(undefined);
  const [formError, setFormError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const mutation = useMutation({
    mutationFn: (body: { email: string }) =>
      apiRequest({ method: "POST", path: props.path, schema: acknowledgedSchema, body }),
    onError: (error) => {
      const described = describeFormError(error, ["email"]);
      setEmailError(described.fields.email);
      setFormError(described.form);
      setAttempt((value) => value + 1);
    },
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mutation.isPending) return;

    const issue = validateEmail(email);
    setFormError(null);
    if (issue !== null) {
      setEmailError(issueMessage("email", issue));
      setAttempt((value) => value + 1);
      return;
    }
    setEmailError(undefined);
    mutation.mutate({ email: email.trim() });
  }

  if (mutation.isSuccess) {
    return (
      <>
        <StateMessage kind="empty" title={props.doneTitle} description={props.doneMessage} />
        <FormLinks links={props.links} />
      </>
    );
  }

  const summaryItems: ErrorSummaryItem[] = [
    ...(emailError === undefined ? [] : [{ fieldId: "email", message: emailError }]),
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
            error={emailError}
          />
          <div>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? props.pendingLabel : props.submitLabel}
            </Button>
          </div>
        </FormStack>
      </form>
      <FormLinks links={props.links} />
    </>
  );
}
