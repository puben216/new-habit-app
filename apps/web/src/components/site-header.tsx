import Link from "next/link";
import type { ReactNode } from "react";

import styles from "./site-header.module.css";

export function SiteHeader({ children }: { children?: ReactNode }) {
  return (
    <header className={styles["header"]}>
      <div className={styles["inner"]}>
        <Link href="/" className={styles["brand"]}>
          AI Habit Coach
        </Link>
        {children}
      </div>
    </header>
  );
}
