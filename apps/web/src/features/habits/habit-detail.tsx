"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { HabitResponse } from "@habit-app/contracts";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { Button } from "@/components/button";
import { ErrorSummary } from "@/components/error-summary";
import { FormStack } from "@/components/form-layout";
import { PageHeader } from "@/components/page-header";
import { StateMessage } from "@/components/state-message";
import {
  toUpdateBody,
  validateHabitForm,
  valuesFromHabit,
  type HabitFormField,
  type HabitFormValues,
} from "@/lib/habits/form";
import {
  HABITS_ROOT_KEY,
  archiveHabit,
  getHabit,
  habitQueryKey,
  updateHabit,
} from "@/lib/habits/habits-api";
import { summarizeDays } from "@/lib/habits/labels";
import {
  ARCHIVED_MESSAGE,
  NOT_FOUND_MESSAGE,
  NO_CHANGES_MESSAGE,
  describeHabitError,
  issueMessage,
} from "@/lib/habits/messages";

import { summaryItems } from "./habit-errors";
import { HabitFields } from "./habit-fields";
import { useToday } from "./use-today";

type Errors = Partial<Record<HabitFormField, string>>;

export function HabitDetail({ habitId }: { habitId: string }) {
  const { today } = useToday();
  // 保存後は version が変わりフォームが作り直されるため、保存済みの表示は親が保持する。
  const [savedVersion, setSavedVersion] = useState<number | null>(null);
  const query = useQuery({
    queryKey: habitQueryKey(habitId),
    queryFn: ({ signal }) => getHabit(habitId, signal),
    retry: false,
  });

  if (query.isPending || today === undefined) {
    return <StateMessage kind="loading" title="読み込んでいます" />;
  }
  if (query.isError) {
    const described = describeHabitError(query.error);
    if (described.kind === "not_found") {
      return (
        <>
          <PageHeader title={NOT_FOUND_MESSAGE} />
          <p>
            <Link href="/habits">習慣の一覧へ戻る</Link>
          </p>
        </>
      );
    }
    return (
      <StateMessage
        kind="error"
        title="読み込めませんでした"
        description={described.form ?? "時間をおいてもう一度お試しください。"}
        action={<Button onClick={() => void query.refetch()}>もう一度試す</Button>}
      />
    );
  }

  return (
    <HabitEditor
      // version が変わる(保存・再読み込み)たびにフォームを最新の値で作り直す。
      key={`${query.data.id}:${query.data.version}`}
      habit={query.data}
      today={today}
      savedVersion={savedVersion}
      onSavedVersion={setSavedVersion}
      reload={() => void query.refetch()}
    />
  );
}

interface HabitEditorProps {
  readonly habit: HabitResponse;
  readonly today: string;
  readonly savedVersion: number | null;
  readonly onSavedVersion: (version: number | null) => void;
  readonly reload: () => void;
}

function HabitEditor({ habit, today, savedVersion, onSavedVersion, reload }: HabitEditorProps) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const archived = habit.status === "archived";
  const [values, setValues] = useState<HabitFormValues>(() => valuesFromHabit(habit, today));
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const saved = savedVersion === habit.version;
  const [confirming, setConfirming] = useState(false);
  const [attempt, setAttempt] = useState(0);

  function handleFailure(error: unknown) {
    const described = describeHabitError(error);
    setConflict(described.kind === "conflict" || described.kind === "archived");
    setErrors(described.fields);
    setFormError(described.form);
    onSavedVersion(null);
    setAttempt((value) => value + 1);
  }

  const update = useMutation({
    mutationFn: (body: NonNullable<ReturnType<typeof toUpdateBody>>) => updateHabit(habit.id, body),
    onSuccess: async (updated) => {
      queryClient.setQueryData(habitQueryKey(habit.id), updated);
      await queryClient.invalidateQueries({ queryKey: HABITS_ROOT_KEY, refetchType: "none" });
      onSavedVersion(updated.version);
    },
    onError: handleFailure,
  });

  const archive = useMutation({
    mutationFn: () => archiveHabit(habit.id, habit.version),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: HABITS_ROOT_KEY });
      router.replace("/habits");
    },
    onError: (error) => {
      setConfirming(false);
      handleFailure(error);
    },
  });

  const busy = update.isPending || archive.isPending || archive.isSuccess;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || archived) return;

    const issues = validateHabitForm(values);
    const nextErrors: Errors = {};
    for (const [field, issue] of Object.entries(issues) as [
      HabitFormField,
      NonNullable<(typeof issues)[HabitFormField]>,
    ][]) {
      nextErrors[field] = issueMessage(field, issue);
    }
    onSavedVersion(null);
    setConflict(false);
    setErrors(nextErrors);
    setFormError(null);
    if (Object.keys(nextErrors).length > 0) {
      setAttempt((value) => value + 1);
      return;
    }
    const body = toUpdateBody(habit, values);
    if (body === null) {
      setFormError(NO_CHANGES_MESSAGE);
      setAttempt((value) => value + 1);
      return;
    }
    update.mutate(body);
  }

  return (
    <>
      <PageHeader title={habit.name} />
      {archived ? (
        <StateMessage kind="empty" title="アーカイブ済み" description={ARCHIVED_MESSAGE} />
      ) : null}
      <form onSubmit={handleSubmit} noValidate aria-busy={busy}>
        <FormStack>
          <ErrorSummary items={summaryItems(errors, formError)} attempt={attempt} />
          {conflict ? (
            <div>
              <p>入力した内容は、読み込むと最新の内容に置き換わります。</p>
              <Button variant="secondary" onClick={reload}>
                最新の内容を読み込む
              </Button>
            </div>
          ) : null}
          <HabitFields
            values={values}
            onChange={(changes) => setValues((current) => ({ ...current, ...changes }))}
            errors={errors}
            kindLocked
            disabled={archived}
          />
          {saved ? <p role="status">保存しました。</p> : null}
          {archived ? null : (
            <div>
              <Button type="submit" disabled={busy}>
                {update.isPending ? "保存しています" : "保存"}
              </Button>
            </div>
          )}
        </FormStack>
      </form>

      <section aria-labelledby="schedule-history">
        <h2 id="schedule-history">スケジュールの履歴</h2>
        <ul>
          {habit.scheduleVersions.map((version) => (
            <li key={version.effectiveFrom}>
              {version.effectiveFrom}
              {version.effectiveTo === null ? "から" : `〜${version.effectiveTo}`}:{" "}
              {summarizeDays(version.daysOfWeek)}
              {habit.kind === "build" ? `(1日${version.targetCount}回)` : ""}
            </li>
          ))}
        </ul>
      </section>

      {archived ? null : (
        <section aria-labelledby="archive-heading">
          <h2 id="archive-heading">アーカイブ</h2>
          {confirming ? (
            <div role="group" aria-labelledby="archive-confirm">
              <p id="archive-confirm">この習慣をアーカイブしますか。進行中の一覧から外れます。</p>
              <Button disabled={busy} onClick={() => archive.mutate()}>
                {archive.isPending ? "アーカイブしています" : "アーカイブする"}
              </Button>{" "}
              <Button variant="secondary" disabled={busy} onClick={() => setConfirming(false)}>
                やめる
              </Button>
            </div>
          ) : (
            <Button variant="secondary" disabled={busy} onClick={() => setConfirming(true)}>
              アーカイブ
            </Button>
          )}
        </section>
      )}
      <p>
        <Link href="/habits">習慣の一覧へ戻る</Link>
      </p>
    </>
  );
}
