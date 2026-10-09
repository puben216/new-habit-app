import type { ReactNode } from "react";

import styles from "./state-message.module.css";

export type StateKind = "loading" | "empty" | "error";

/** 色だけに依存せず、種類を文字ラベルでも示す(WCAG 1.4.1、WUI-003)。 */
const KIND_LABEL: Record<StateKind, string> = {
  loading: "読み込み中",
  empty: "データなし",
  error: "エラー",
};

export interface StateMessageProps {
  readonly kind: StateKind;
  readonly title: string;
  readonly description?: string;
  /** 再試行などの操作。 */
  readonly action?: ReactNode;
  /**
   * 見出しの階層。画面の主題として単独で表示するとき(error/not-found)は 1、
   * 他の見出しの下に置くときは 2(既定)。1 画面に `h1` は 1 つだけにする(WUI-001)。
   */
  readonly headingLevel?: 1 | 2;
}

function roleFor(kind: StateKind): "status" | "alert" | undefined {
  switch (kind) {
    case "loading":
      return "status";
    case "error":
      return "alert";
    case "empty":
      return undefined;
    default: {
      const unreachable: never = kind;
      return unreachable;
    }
  }
}

/**
 * 読み込み・空・エラーの共通表示。`title`/`description` は呼び出し側が持つ固定の文言とし、
 * server の `message` や例外の `message` を渡さない(WUI-INV-003)。
 */
export function StateMessage({
  kind,
  title,
  description,
  action,
  headingLevel = 2,
}: StateMessageProps) {
  const Heading = headingLevel === 1 ? "h1" : "h2";
  return (
    <section className={`${styles["root"]} ${styles[kind]}`} role={roleFor(kind)}>
      <p className={styles["label"]}>{KIND_LABEL[kind]}</p>
      <Heading className={styles["title"]}>{title}</Heading>
      {description === undefined ? null : <p className={styles["description"]}>{description}</p>}
      {action === undefined ? null : <div className={styles["action"]}>{action}</div>}
    </section>
  );
}
