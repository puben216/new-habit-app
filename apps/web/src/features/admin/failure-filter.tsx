import Link from "next/link";

import styles from "./admin.module.css";

export interface FailureFilterOption {
  /** `undefined` は「すべて」。 */
  readonly value: string | undefined;
  readonly label: string;
}

/** 一覧の状態の絞り込み。`status` は個人情報を含まないので URL に載せる(ADS-006)。 */
export function FailureFilter({
  basePath,
  current,
  options,
}: {
  readonly basePath: string;
  readonly current: string | undefined;
  readonly options: readonly FailureFilterOption[];
}) {
  return (
    <nav aria-label="状態の絞り込み" className={styles["tabs"]}>
      {options.map((option) => (
        <Link
          key={option.value ?? "all"}
          href={option.value === undefined ? basePath : `${basePath}?status=${option.value}`}
          className={styles["tab"]}
          aria-current={option.value === current ? "page" : undefined}
        >
          {option.label}
        </Link>
      ))}
    </nav>
  );
}
