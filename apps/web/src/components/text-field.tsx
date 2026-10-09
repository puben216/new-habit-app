import type { InputHTMLAttributes } from "react";

import styles from "./text-field.module.css";

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "id"> {
  readonly id: string;
  readonly label: string;
  /** 常時表示する補足(入力条件など)。 */
  readonly hint?: string;
  /** 固定の文言のエラー。ある場合は `aria-invalid` を付ける。 */
  readonly error?: string | undefined;
}

/**
 * ラベル付きの入力欄(WCAG 1.3.1、3.3.1)。補足とエラーは `aria-describedby` で入力欄に関連付け、
 * エラーは色だけでなく文字(「エラー:」)でも示す。
 */
export function TextField({ id, label, hint, error, ...inputProps }: TextFieldProps) {
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
      <input
        {...inputProps}
        id={id}
        className={`${styles["input"]} ${error === undefined ? "" : styles["invalid"]}`}
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
