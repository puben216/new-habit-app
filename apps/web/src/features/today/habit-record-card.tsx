"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { TodayScheduleResponse } from "@habit-app/contracts";
import { useRef, useState } from "react";

import { Button } from "@/components/button";
import {
  ACTION_LABELS,
  actionForEntry,
  entryBodyFor,
  entryLabel,
  type RecordAction,
} from "@/lib/today/entry-actions";
import { DASHBOARD_QUERY_KEY } from "@/lib/dashboard/dashboard-api";
import { RECORDED_MESSAGE, describeRecordError } from "@/lib/today/messages";
import { SCHEDULE_ROOT_KEY, putEntry } from "@/lib/today/today-api";

import styles from "./habit-record-card.module.css";

type Item = TodayScheduleResponse["items"][number];

export interface HabitRecordCardProps {
  readonly item: Item;
  /** 記録する日(画面で選択中の日付)。 */
  readonly date: string;
}

const MAIN_ACTIONS = ["done", "missed", "skipped"] as const;

export function HabitRecordCard({ item, date }: HabitRecordCardProps) {
  const queryClient = useQueryClient();
  const { habit, targetCount, entry } = item;
  const [quantity, setQuantity] = useState("");
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  // クリックが再描画より速く連続しても二重に送らないための同期的なロック。
  const inFlight = useRef(false);

  const mutation = useMutation({
    mutationFn: (variables: { action: RecordAction; quantity?: number }) =>
      putEntry(habit.id, date, entryBodyFor(habit.kind, variables.action, variables.quantity)),
    onSettled: () => {
      inFlight.current = false;
    },
    onSuccess: async () => {
      setMessage({ kind: "ok", text: RECORDED_MESSAGE });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: SCHEDULE_ROOT_KEY }),
        queryClient.invalidateQueries({ queryKey: DASHBOARD_QUERY_KEY }),
      ]);
    },
    onError: async (error) => {
      setMessage({ kind: "error", text: describeRecordError(error) });
      await queryClient.invalidateQueries({ queryKey: SCHEDULE_ROOT_KEY });
    },
  });

  const pressed = actionForEntry(entry);
  const pending = mutation.isPending;
  const progressValue = Number(quantity);
  const progressValid =
    quantity.trim() !== "" && Number.isInteger(progressValue) && progressValue >= 0;

  function record(action: RecordAction, amount?: number) {
    if (inFlight.current) return;
    inFlight.current = true;
    setMessage(null);
    mutation.mutate(amount === undefined ? { action } : { action, quantity: amount });
  }

  return (
    <li className={styles["card"]}>
      <h3 className={styles["name"]}>{habit.name}</h3>
      <p className={styles["meta"]}>きっかけ: {habit.cue}</p>
      <p className={styles["meta"]}>最小の行動: {habit.minimumAction}</p>
      {habit.kind === "reduce" && habit.replacementAction !== null ? (
        <p className={styles["meta"]}>代わりの行動: {habit.replacementAction}</p>
      ) : null}
      {habit.kind === "build" && targetCount > 1 ? (
        <p className={styles["meta"]}>目標: 1日{targetCount}回</p>
      ) : null}
      <p className={styles["state"]}>
        現在の記録: <strong>{entryLabel(habit.kind, entry, targetCount)}</strong>
      </p>

      <div role="group" aria-label={`${habit.name}の記録`} className={styles["actions"]}>
        {MAIN_ACTIONS.map((action) => (
          <Button
            key={action}
            variant="secondary"
            disabled={pending}
            aria-pressed={pressed === action}
            onClick={() => record(action)}
          >
            {ACTION_LABELS[habit.kind][action]}
          </Button>
        ))}
      </div>

      {habit.kind === "build" && targetCount > 1 ? (
        <div className={styles["progress"]}>
          <label htmlFor={`progress-${habit.id}`}>途中経過の回数</label>
          <input
            id={`progress-${habit.id}`}
            type="number"
            inputMode="numeric"
            min={0}
            value={quantity}
            onChange={(event) => setQuantity(event.target.value)}
            className={styles["input"]}
          />
          <Button
            variant="secondary"
            disabled={pending || !progressValid}
            aria-pressed={pressed === "progress"}
            onClick={() => record("progress", progressValue)}
          >
            途中経過を記録
          </Button>
        </div>
      ) : null}

      {message === null ? null : message.kind === "ok" ? (
        <p role="status">{message.text}</p>
      ) : (
        <p role="alert" className={styles["error"]}>
          {message.text}
        </p>
      )}
    </li>
  );
}
