"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { DailyCheckInResponse } from "@habit-app/contracts";
import { useState, type FormEvent } from "react";

import { Button } from "@/components/button";
import { ErrorSummary } from "@/components/error-summary";
import { StateMessage } from "@/components/state-message";
import { TextAreaField } from "@/components/textarea-field";
import { NOTE_MAX, toCheckInBody, validateCheckIn, type CheckInValues } from "@/lib/today/check-in";
import {
  CHECK_IN_SAVED_MESSAGE,
  checkInIssueMessage,
  describeCheckInError,
} from "@/lib/today/messages";
import { checkInKey, getCheckIn, putCheckIn } from "@/lib/today/today-api";

import styles from "./check-in-form.module.css";

export function CheckInForm({ date }: { date: string }) {
  const query = useQuery({
    queryKey: checkInKey(date),
    queryFn: ({ signal }) => getCheckIn(date, signal),
    retry: false,
  });

  if (query.isPending)
    return <StateMessage kind="loading" title="チェックインを読み込んでいます" />;
  if (query.isError) {
    return (
      <StateMessage
        kind="error"
        title="チェックインを読み込めませんでした"
        action={<Button onClick={() => void query.refetch()}>もう一度試す</Button>}
      />
    );
  }
  return <CheckInFormBody key={date} date={date} saved={query.data} />;
}

interface ScaleProps {
  readonly name: string;
  readonly legend: string;
  readonly hint: string;
  readonly value: number | null;
  readonly onChange: (value: number | null) => void;
}

function ScaleField({ name, legend, hint, value, onChange }: ScaleProps) {
  return (
    <fieldset className={styles["fieldset"]}>
      <legend className={styles["legend"]}>{legend}</legend>
      <p className={styles["hint"]}>{hint}</p>
      <div className={styles["scale"]}>
        <label className={styles["choice"]}>
          <input
            type="radio"
            name={name}
            checked={value === null}
            onChange={() => onChange(null)}
          />
          未設定
        </label>
        {[1, 2, 3, 4, 5].map((number) => (
          <label key={number} className={styles["choice"]}>
            <input
              type="radio"
              name={name}
              value={number}
              checked={value === number}
              onChange={() => onChange(number)}
            />
            {number}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function CheckInFormBody({ date, saved }: { date: string; saved: DailyCheckInResponse | null }) {
  const queryClient = useQueryClient();
  const [values, setValues] = useState<CheckInValues>({
    mood: saved?.mood ?? null,
    difficulty: saved?.difficulty ?? null,
    note: saved?.note ?? "",
  });
  const [error, setError] = useState<string | null>(null);
  const [noteError, setNoteError] = useState<string | undefined>(undefined);
  const [done, setDone] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const mutation = useMutation({
    mutationFn: () => putCheckIn(date, toCheckInBody(values)),
    onSuccess: (result) => {
      queryClient.setQueryData(checkInKey(date), result);
      setDone(true);
    },
    onError: (failure) => {
      setError(describeCheckInError(failure));
      setAttempt((value) => value + 1);
    },
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mutation.isPending) return;
    setDone(false);
    setError(null);
    setNoteError(undefined);

    const issue = validateCheckIn(values);
    if (issue !== null) {
      const message = checkInIssueMessage(issue);
      if (issue === "note_too_long") setNoteError(message);
      else setError(message);
      setAttempt((value) => value + 1);
      return;
    }
    mutation.mutate();
  }

  const summary = [
    ...(noteError === undefined ? [] : [{ fieldId: "note", message: noteError }]),
    ...(error === null ? [] : [{ message: error }]),
  ];

  return (
    <form
      onSubmit={handleSubmit}
      noValidate
      aria-busy={mutation.isPending}
      className={styles["form"]}
    >
      <ErrorSummary items={summary} attempt={attempt} />
      <ScaleField
        name="mood"
        legend="気分"
        hint="1 = 低い、5 = 良い"
        value={values.mood}
        onChange={(mood) => setValues((current) => ({ ...current, mood }))}
      />
      <ScaleField
        name="difficulty"
        legend="今日の難しさ"
        hint="1 = 易しかった、5 = 難しかった"
        value={values.difficulty}
        onChange={(difficulty) => setValues((current) => ({ ...current, difficulty }))}
      />
      <TextAreaField
        id="note"
        name="note"
        label="メモ"
        hint={`${NOTE_MAX}文字以内`}
        value={values.note}
        onChange={(event) => setValues((current) => ({ ...current, note: event.target.value }))}
        error={noteError}
      />
      {done ? <p role="status">{CHECK_IN_SAVED_MESSAGE}</p> : null}
      <div>
        <Button type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? "保存しています" : "チェックインを保存"}
        </Button>
      </div>
    </form>
  );
}
