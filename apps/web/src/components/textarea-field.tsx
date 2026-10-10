import type { TextareaHTMLAttributes } from "react";

import styles from "./text-field.module.css";

export interface TextAreaFieldProps extends Omit<
  TextareaHTMLAttributes<HTMLTextAreaElement>,
  "id"
> {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
  readonly error?: string | undefined;
}

/** ラベル付きの複数行入力。a11y の規約は `TextField` と同じ。 */
export function TextAreaField({ id, label, hint, error, ...props }: TextAreaFieldProps) {
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
      <textarea
        {...props}
        id={id}
        rows={props.rows ?? 4}
        className={`${styles["input"]} ${styles["textarea"]} ${error === undefined ? "" : styles["invalid"]}`}
        aria-invalid={error === undefined ? undefined : true}
        aria-describedby={describedBy}
      />
      {error === undefined ? null : (
        <p id={errorId} className={styles["error"]}>
          <span aria-hidden="true">エラー: </span>
          {error}
        </p>
      )}
    </div>
  );
}
