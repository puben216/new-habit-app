import type { SelectHTMLAttributes } from "react";

import styles from "./text-field.module.css";

export interface SelectFieldProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "id"> {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
  readonly error?: string | undefined;
  readonly options: readonly { readonly value: string; readonly label: string }[];
}

/** ラベル付きの選択欄。a11y の規約は `TextField` と同じ(label、hint、エラーの関連付け)。 */
export function SelectField({ id, label, hint, error, options, ...selectProps }: SelectFieldProps) {
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy =
    [hint === undefined ? null : hintId, error === undefined ? null : errorId]
      .filter((value): value is string => value !== null)
      .join(" ") || undefined;

  return (
    <div className={styles["field"]}>
      <label htmlFor={id} className={styles["label"]}>
        {label}
      </label>
      {hint === undefined ? null : (
        <p id={hintId} className={styles["hint"]}>
          {hint}
        </p>
      )}
      <select
        {...selectProps}
        id={id}
        className={`${styles["input"]} ${error === undefined ? "" : styles["invalid"]}`}
        aria-invalid={error === undefined ? undefined : true}
        aria-describedby={describedBy}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {error === undefined ? null : (
        <p id={errorId} className={styles["error"]}>
          <span aria-hidden="true">エラー: </span>
          {error}
        </p>
      )}
    </div>
  );
}
