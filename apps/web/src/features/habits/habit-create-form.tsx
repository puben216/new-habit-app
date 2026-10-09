"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { Button } from "@/components/button";
import { ErrorSummary } from "@/components/error-summary";
import { FormLinks, FormStack } from "@/components/form-layout";
import { StateMessage } from "@/components/state-message";
import {
  toCreateBody,
  validateHabitForm,
  type HabitFormField,
  type HabitFormValues,
} from "@/lib/habits/form";
import { HABITS_ROOT_KEY, createHabit } from "@/lib/habits/habits-api";
import { describeHabitError, issueMessage } from "@/lib/habits/messages";

import { summaryItems } from "./habit-errors";
import { HabitFields } from "./habit-fields";
import { useToday } from "./use-today";

type Errors = Partial<Record<HabitFormField, string>>;

function initialValues(today: string): HabitFormValues {
  return {
    kind: "build",
    name: "",
    purpose: "",
    cue: "",
    minimumAction: "",
    replacementAction: "",
    effectiveFrom: today,
    daysOfWeek: [],
    targetCount: "1",
  };
}

export function HabitCreateForm() {
  const { today, isError, refetch } = useToday();
  if (isError) {
    return (
      <StateMessage
        kind="error"
        title="読み込めませんでした"
        description="時間をおいてもう一度お試しください。"
        action={<Button onClick={refetch}>もう一度試す</Button>}
      />
    );
  }
  if (today === undefined) return <StateMessage kind="loading" title="読み込んでいます" />;
  return <CreateFormBody today={today} />;
}

function CreateFormBody({ today }: { today: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [values, setValues] = useState<HabitFormValues>(() => initialValues(today));
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const mutation = useMutation({
    mutationFn: createHabit,
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({ queryKey: HABITS_ROOT_KEY });
      router.push(`/habits/${created.id}`);
    },
    onError: (error) => {
      const described = describeHabitError(error);
      setErrors(described.fields);
      setFormError(described.form);
      setAttempt((value) => value + 1);
    },
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mutation.isPending || mutation.isSuccess) return;

    const issues = validateHabitForm(values);
    const nextErrors: Errors = {};
    for (const [field, issue] of Object.entries(issues) as [
      HabitFormField,
      NonNullable<(typeof issues)[HabitFormField]>,
    ][]) {
      nextErrors[field] = issueMessage(field, issue);
    }
    setErrors(nextErrors);
    setFormError(null);
    if (Object.keys(nextErrors).length > 0) {
      setAttempt((value) => value + 1);
      return;
    }
    mutation.mutate(toCreateBody(values));
  }

  const busy = mutation.isPending || mutation.isSuccess;

  return (
    <>
      <form onSubmit={handleSubmit} noValidate aria-busy={busy}>
        <FormStack>
          <ErrorSummary items={summaryItems(errors, formError)} attempt={attempt} />
          <HabitFields
            values={values}
            onChange={(changes) => setValues((current) => ({ ...current, ...changes }))}
            errors={errors}
            kindLocked={false}
          />
          <div>
            <Button type="submit" disabled={busy}>
              {busy ? "保存しています" : "習慣を作る"}
            </Button>
          </div>
        </FormStack>
      </form>
      <FormLinks links={[{ href: "/habits", label: "習慣の一覧へ戻る" }]} />
    </>
  );
}
