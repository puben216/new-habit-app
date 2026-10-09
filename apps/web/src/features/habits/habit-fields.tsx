"use client";

import { TextField } from "@/components/text-field";
import { TARGET_COUNT_MAX, type HabitFormField, type HabitFormValues } from "@/lib/habits/form";
import { DAY_NAMES, kindLabel } from "@/lib/habits/labels";

import styles from "./habit-fields.module.css";

export interface HabitFieldsProps {
  readonly values: HabitFormValues;
  readonly onChange: (changes: Partial<HabitFormValues>) => void;
  readonly errors: Partial<Record<HabitFormField, string>>;
  /** 種類は作成時のみ選べる。 */
  readonly kindLocked: boolean;
  readonly disabled?: boolean;
}

/** 習慣の入力欄(作成・編集共通)。reduce は回数欄を出さず(1 固定)、代わりの行動の欄を出す。 */
export function HabitFields({ values, onChange, errors, kindLocked, disabled }: HabitFieldsProps) {
  const isReduce = values.kind === "reduce";

  return (
    <>
      <fieldset className={styles["fieldset"]} disabled={disabled}>
        <legend className={styles["legend"]}>種類</legend>
        {kindLocked ? (
          <p>{kindLabel(values.kind)}</p>
        ) : (
          (["build", "reduce"] as const).map((kind) => (
            <label key={kind} className={styles["choice"]}>
              <input
                type="radio"
                name="kind"
                value={kind}
                checked={values.kind === kind}
                onChange={() => onChange({ kind })}
              />
              {kindLabel(kind)}
            </label>
          ))
        )}
      </fieldset>
      <TextField
        id="name"
        name="name"
        label="名前"
        value={values.name}
        onChange={(event) => onChange({ name: event.target.value })}
        error={errors.name}
        disabled={disabled}
      />
      <TextField
        id="purpose"
        name="purpose"
        label="目的"
        hint="なぜこの習慣を続けたいのか"
        value={values.purpose}
        onChange={(event) => onChange({ purpose: event.target.value })}
        error={errors.purpose}
        disabled={disabled}
      />
      <TextField
        id="cue"
        name="cue"
        label="きっかけ"
        hint="いつ・どんなときに行うか"
        value={values.cue}
        onChange={(event) => onChange({ cue: event.target.value })}
        error={errors.cue}
        disabled={disabled}
      />
      <TextField
        id="minimumAction"
        name="minimumAction"
        label="最小の行動"
        hint="調子が悪い日でもできる、いちばん小さな行動"
        value={values.minimumAction}
        onChange={(event) => onChange({ minimumAction: event.target.value })}
        error={errors.minimumAction}
        disabled={disabled}
      />
      {isReduce ? (
        <TextField
          id="replacementAction"
          name="replacementAction"
          label="代わりの行動(任意)"
          value={values.replacementAction}
          onChange={(event) => onChange({ replacementAction: event.target.value })}
          error={errors.replacementAction}
          disabled={disabled}
        />
      ) : null}
      <fieldset className={styles["fieldset"]} disabled={disabled}>
        <legend className={styles["legend"]}>スケジュール</legend>
        <TextField
          id="effectiveFrom"
          name="effectiveFrom"
          label="適用開始日"
          type="date"
          value={values.effectiveFrom}
          onChange={(event) => onChange({ effectiveFrom: event.target.value })}
          error={errors.effectiveFrom}
        />
        <div
          id="daysOfWeek"
          tabIndex={-1}
          role="group"
          aria-labelledby="daysOfWeek-label"
          aria-describedby={errors.daysOfWeek === undefined ? undefined : "daysOfWeek-error"}
          className={styles["days"]}
        >
          <p id="daysOfWeek-label" className={styles["subLegend"]}>
            曜日
          </p>
          {DAY_NAMES.map((name, day) => (
            <label key={name} className={styles["choice"]}>
              <input
                type="checkbox"
                name="daysOfWeek"
                value={day}
                checked={values.daysOfWeek.includes(day)}
                onChange={(event) =>
                  onChange({
                    daysOfWeek: event.target.checked
                      ? [...values.daysOfWeek, day]
                      : values.daysOfWeek.filter((value) => value !== day),
                  })
                }
              />
              {name}
            </label>
          ))}
          {errors.daysOfWeek === undefined ? null : (
            <p id="daysOfWeek-error" className={styles["error"]}>
              <span aria-hidden="true">エラー: </span>
              {errors.daysOfWeek}
            </p>
          )}
        </div>
        {isReduce ? null : (
          <TextField
            id="targetCount"
            name="targetCount"
            label="1日の回数"
            hint={`1〜${TARGET_COUNT_MAX}`}
            type="number"
            inputMode="numeric"
            min={1}
            max={TARGET_COUNT_MAX}
            value={values.targetCount}
            onChange={(event) => onChange({ targetCount: event.target.value })}
            error={errors.targetCount}
          />
        )}
      </fieldset>
    </>
  );
}
