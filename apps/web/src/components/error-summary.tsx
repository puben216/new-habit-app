"use client";

import { useEffect, useRef } from "react";

import styles from "./error-summary.module.css";

export interface ErrorSummaryItem {
  /** 対応する入力欄の id。ない場合(フォーム全体のエラー)はリンクにしない。 */
  readonly fieldId?: string;
  readonly message: string;
}

export interface ErrorSummaryProps {
  readonly items: readonly ErrorSummaryItem[];
  /** 送信の試行ごとに増やす。増えるたびに(エラーがあれば)要約へフォーカスを移す。 */
  readonly attempt: number;
}

/**
 * フォーム上部のエラー要約(WCAG 3.3.1)。`role="alert"` で読み上げ、送信失敗のたびにフォーカスを移し、
 * 項目のエラーは該当の入力欄へのリンクにする。
 */
export function ErrorSummary({ items, attempt }: ErrorSummaryProps) {
  const ref = useRef<HTMLDivElement>(null);
  const hasItems = items.length > 0;

  useEffect(() => {
    if (hasItems) ref.current?.focus();
  }, [attempt, hasItems]);

  if (!hasItems) return null;

  return (
    <div ref={ref} role="alert" tabIndex={-1} className={styles["summary"]}>
      <p className={styles["title"]}>入力内容を確認してください</p>
      <ul className={styles["list"]}>
        {items.map((item) => (
          <li key={`${item.fieldId ?? "form"}:${item.message}`}>
            {item.fieldId === undefined ? (
              item.message
            ) : (
              <a href={`#${item.fieldId}`}>{item.message}</a>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
