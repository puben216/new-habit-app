"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState, type FormEvent } from "react";

import { Button } from "@/components/button";
import { ErrorSummary, type ErrorSummaryItem } from "@/components/error-summary";
import { FormStack } from "@/components/form-layout";
import { SelectField } from "@/components/select-field";
import { StateMessage } from "@/components/state-message";
import { TextField } from "@/components/text-field";
import {
  NOTIFICATION_QUERY_KEY,
  fetchNotificationSettings,
  putNotificationSettings,
} from "@/lib/notifications/notification-api";
import {
  ENABLED_MESSAGE,
  RESUME_REJECTED_MESSAGE,
  SAVED_MESSAGE,
  STOPPED_MESSAGE,
  describeNotificationError,
  issueMessage,
  statusLabel,
  toPutBody,
  toggleBody,
  validateForm,
  valuesFromSaved,
  type FormField,
  type FormValues,
  type Saved,
} from "@/lib/notifications/settings";
import { buildTimezoneOptions } from "@/lib/profile/timezone-options";

import styles from "./notifications-view.module.css";

export function NotificationsView({
  supportedTimezones,
}: {
  supportedTimezones: readonly string[];
}) {
  const query = useQuery({
    queryKey: NOTIFICATION_QUERY_KEY,
    queryFn: ({ signal }) => fetchNotificationSettings(signal),
  });

  if (query.isPending) return <StateMessage kind="loading" title="読み込んでいます" />;
  if (query.isError) {
    return (
      <StateMessage
        kind="error"
        title="通知設定を読み込めませんでした"
        description="時間をおいてもう一度お試しください。"
        action={<Button onClick={() => void query.refetch()}>もう一度試す</Button>}
      />
    );
  }
  return <Body saved={query.data} supportedTimezones={supportedTimezones} />;
}

function Body({
  saved,
  supportedTimezones,
}: {
  saved: Saved;
  supportedTimezones: readonly string[];
}) {
  const queryClient = useQueryClient();
  const [values, setValues] = useState<FormValues>(() => valuesFromSaved(saved));
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<FormField, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [toggleError, setToggleError] = useState<string | null>(null);
  // クリックが再描画より速く連続しても二重に送らないための同期的なロック。
  const inFlight = useRef(false);

  const toggle = useMutation({
    mutationFn: (enabled: boolean) => putNotificationSettings(toggleBody(saved, enabled)),
    onSuccess: (result) => {
      queryClient.setQueryData(NOTIFICATION_QUERY_KEY, result);
      setMessage(result.enabled ? ENABLED_MESSAGE : STOPPED_MESSAGE);
    },
    onError: (error) => {
      const described = describeNotificationError(error);
      setToggleError(
        described.fields.localTime === undefined
          ? (described.form ?? RESUME_REJECTED_MESSAGE)
          : RESUME_REJECTED_MESSAGE,
      );
    },
    onSettled: () => {
      inFlight.current = false;
    },
  });

  const save = useMutation({
    mutationFn: () => putNotificationSettings(toPutBody(saved, values)),
    onSuccess: (result) => {
      queryClient.setQueryData(NOTIFICATION_QUERY_KEY, result);
      setMessage(SAVED_MESSAGE);
    },
    onError: (error) => {
      const described = describeNotificationError(error);
      setFieldErrors(described.fields);
      setFormError(described.form);
      setAttempt((value) => value + 1);
    },
    onSettled: () => {
      inFlight.current = false;
    },
  });

  function flip() {
    if (inFlight.current) return;
    inFlight.current = true;
    setMessage(null);
    setToggleError(null);
    toggle.mutate(!saved.enabled);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    setMessage(null);
    setFormError(null);

    const issues = validateForm(values);
    const nextErrors: Partial<Record<FormField, string>> = {};
    for (const field of Object.keys(issues) as FormField[]) nextErrors[field] = issueMessage(field);
    setFieldErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      setAttempt((value) => value + 1);
      return;
    }
    inFlight.current = true;
    save.mutate();
  }

  const timezoneOptions = buildTimezoneOptions(supportedTimezones, saved.timezone);
  const busy = toggle.isPending || save.isPending;
  const summary: ErrorSummaryItem[] = [
    ...(fieldErrors.localTime === undefined
      ? []
      : [{ fieldId: "localTime", message: fieldErrors.localTime }]),
    ...(fieldErrors.timezone === undefined
      ? []
      : [{ fieldId: "timezone", message: fieldErrors.timezone }]),
    ...(fieldErrors.quietHours === undefined
      ? []
      : [{ fieldId: "quietStart", message: fieldErrors.quietHours }]),
    ...(formError === null ? [] : [{ message: formError }]),
  ];

  return (
    <>
      <section aria-labelledby="status-heading" className={styles["panel"]}>
        <h2 id="status-heading">現在の状態</h2>
        <p className={styles["status"]}>
          <strong>{statusLabel(saved)}</strong>
        </p>
        <p className={styles["note"]}>
          通知は初期状態で停止しています。停止してもいつでも再開でき、設定は保持されます。
        </p>
        <Button disabled={busy} onClick={flip}>
          {saved.enabled ? "通知を停止する" : "通知を有効にする"}
        </Button>
        {toggleError === null ? null : (
          <p role="alert" className={styles["error"]}>
            {toggleError}
          </p>
        )}
        {message !== null && toggleError === null ? <p role="status">{message}</p> : null}
      </section>

      <section aria-labelledby="settings-heading">
        <h2 id="settings-heading">送信の設定</h2>
        <p className={styles["note"]}>
          送信時刻と送らない時間帯は、選んだタイムゾーンのローカル時刻です。保存しても、有効・停止の状態は変わりません。
        </p>
        <form onSubmit={handleSubmit} noValidate aria-busy={busy}>
          <FormStack>
            <ErrorSummary items={summary} attempt={attempt} />
            <TextField
              id="localTime"
              name="localTime"
              label="送信時刻"
              type="time"
              value={values.localTime}
              onChange={(event) =>
                setValues((current) => ({ ...current, localTime: event.target.value }))
              }
              error={fieldErrors.localTime}
            />
            <SelectField
              id="timezone"
              name="timezone"
              label="タイムゾーン"
              value={values.timezone}
              onChange={(event) =>
                setValues((current) => ({ ...current, timezone: event.target.value }))
              }
              options={timezoneOptions.map((value) => ({ value, label: value }))}
              error={fieldErrors.timezone}
            />
            <fieldset className={styles["fieldset"]}>
              <legend className={styles["legend"]}>送らない時間帯</legend>
              <label className={styles["choice"]}>
                <input
                  type="checkbox"
                  checked={values.quietEnabled}
                  onChange={(event) =>
                    setValues((current) => ({ ...current, quietEnabled: event.target.checked }))
                  }
                />
                送らない時間帯を設定する
              </label>
              <TextField
                id="quietStart"
                name="quietStart"
                label="開始"
                type="time"
                disabled={!values.quietEnabled}
                value={values.quietStart}
                onChange={(event) =>
                  setValues((current) => ({ ...current, quietStart: event.target.value }))
                }
                error={fieldErrors.quietHours}
              />
              <TextField
                id="quietEnd"
                name="quietEnd"
                label="終了"
                type="time"
                disabled={!values.quietEnabled}
                value={values.quietEnd}
                onChange={(event) =>
                  setValues((current) => ({ ...current, quietEnd: event.target.value }))
                }
              />
            </fieldset>
            <div>
              <Button type="submit" disabled={busy}>
                {save.isPending ? "保存しています" : "設定を保存"}
              </Button>
            </div>
          </FormStack>
        </form>
      </section>
    </>
  );
}
