"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ProfileResponse } from "@habit-app/contracts";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { Button } from "@/components/button";
import { ErrorSummary, type ErrorSummaryItem } from "@/components/error-summary";
import { FormStack } from "@/components/form-layout";
import { SelectField } from "@/components/select-field";
import { StateMessage } from "@/components/state-message";
import { TextField } from "@/components/text-field";
import { CLIENT_ERROR_CODES, isApiError } from "@/lib/api/api-error";
import { PROFILE_QUERY_KEY, fetchProfile, updateProfile } from "@/lib/profile/profile-api";
import {
  PROFILE_LOAD_FAILED_MESSAGE,
  PROFILE_NETWORK_MESSAGE,
  PROFILE_SAVED_MESSAGE,
  PROFILE_UNEXPECTED_MESSAGE,
  WEEKDAY_LABELS,
  displayNameIssueMessage,
  mapProfileFieldErrors,
  type ProfileField,
} from "@/lib/profile/messages";
import { buildTimezoneOptions, pickInitialTimezone } from "@/lib/profile/timezone-options";
import { validateDisplayName } from "@/lib/profile/validation";

export type ProfileFormMode = "onboarding" | "profile";

export interface ProfileFormProps {
  readonly mode: ProfileFormMode;
  /** server が `Intl.supportedValuesOf("timeZone")` から作った候補。 */
  readonly supportedTimezones: readonly string[];
}

export function ProfileForm({ mode, supportedTimezones }: ProfileFormProps) {
  const query = useQuery({
    queryKey: PROFILE_QUERY_KEY,
    queryFn: ({ signal }) => fetchProfile(signal),
  });

  if (query.isPending) return <StateMessage kind="loading" title="読み込んでいます" />;
  if (query.isError) {
    return (
      <StateMessage
        kind="error"
        title={PROFILE_LOAD_FAILED_MESSAGE}
        description="時間をおいてもう一度お試しください。"
        action={<Button onClick={() => void query.refetch()}>もう一度試す</Button>}
      />
    );
  }
  return (
    <ProfileFormBody mode={mode} profile={query.data} supportedTimezones={supportedTimezones} />
  );
}

function ProfileFormBody({
  mode,
  profile,
  supportedTimezones,
}: ProfileFormProps & { readonly profile: ProfileResponse }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const options = buildTimezoneOptions(supportedTimezones, profile.timezone);

  const [displayName, setDisplayName] = useState(profile.displayName ?? "");
  // オンボーディングでは、ブラウザのタイムゾーンを初期選択として提案する。この component は
  // query 取得後に client でのみ mount されるため、server との hydration 不整合は起きない。
  const [timezone, setTimezone] = useState(() =>
    mode === "onboarding"
      ? pickInitialTimezone(
          Intl.DateTimeFormat().resolvedOptions().timeZone,
          options,
          profile.timezone,
        )
      : profile.timezone,
  );
  const [weekStartsOn, setWeekStartsOn] = useState(String(profile.weekStartsOn));
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<ProfileField, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const mutation = useMutation({
    mutationFn: updateProfile,
    onSuccess: (saved) => {
      queryClient.setQueryData(PROFILE_QUERY_KEY, saved);
      if (mode === "onboarding") router.replace("/today");
    },
    onError: (error) => {
      if (isApiError(error) && error.code === CLIENT_ERROR_CODES.networkError) {
        setFieldErrors({});
        setFormError(PROFILE_NETWORK_MESSAGE);
      } else if (isApiError(error) && error.status === 422) {
        const mapped = mapProfileFieldErrors(error.fieldErrors);
        setFieldErrors(mapped.fields);
        setFormError(mapped.form);
      } else {
        setFieldErrors({});
        setFormError(PROFILE_UNEXPECTED_MESSAGE);
      }
      setAttempt((value) => value + 1);
    },
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mutation.isPending) return;

    const issue = validateDisplayName(displayName);
    setFormError(null);
    if (issue !== null) {
      setFieldErrors({ displayName: displayNameIssueMessage(issue) });
      setAttempt((value) => value + 1);
      return;
    }
    setFieldErrors({});
    mutation.mutate({
      displayName: displayName.trim(),
      timezone,
      weekStartsOn: Number(weekStartsOn),
    });
  }

  const summaryItems: ErrorSummaryItem[] = [
    ...(fieldErrors.displayName === undefined
      ? []
      : [{ fieldId: "displayName", message: fieldErrors.displayName }]),
    ...(fieldErrors.timezone === undefined
      ? []
      : [{ fieldId: "timezone", message: fieldErrors.timezone }]),
    ...(fieldErrors.weekStartsOn === undefined
      ? []
      : [{ fieldId: "weekStartsOn", message: fieldErrors.weekStartsOn }]),
    ...(formError === null ? [] : [{ message: formError }]),
  ];

  return (
    <form onSubmit={handleSubmit} noValidate aria-busy={mutation.isPending}>
      <FormStack>
        <ErrorSummary items={summaryItems} attempt={attempt} />
        <TextField
          id="displayName"
          name="displayName"
          label="表示名"
          hint="50文字以内"
          autoComplete="nickname"
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          error={fieldErrors.displayName}
        />
        <SelectField
          id="timezone"
          name="timezone"
          label="タイムゾーン"
          hint="「今日」の日付の判定に使います。"
          value={timezone}
          onChange={(event) => {
            setTimezone(event.target.value);
          }}
          options={options.map((value) => ({ value, label: value }))}
          error={fieldErrors.timezone}
        />
        <SelectField
          id="weekStartsOn"
          name="weekStartsOn"
          label="週の開始曜日"
          value={weekStartsOn}
          onChange={(event) => setWeekStartsOn(event.target.value)}
          options={WEEKDAY_LABELS.map((label, index) => ({ value: String(index), label }))}
          error={fieldErrors.weekStartsOn}
        />
        {mutation.isSuccess && mode === "profile" ? (
          <p role="status">{PROFILE_SAVED_MESSAGE}</p>
        ) : null}
        <div>
          <Button type="submit" disabled={mutation.isPending}>
            {mutation.isPending ? "保存しています" : mode === "onboarding" ? "はじめる" : "保存"}
          </Button>
        </div>
      </FormStack>
    </form>
  );
}
