import type { ReactNode } from "react";

import styles from "./header-actions.module.css";

/** ヘッダー右側のナビゲーションと操作(ログアウト等)をまとめる。 */
export function HeaderActions({ children }: { children: ReactNode }) {
  return <div className={styles["root"]}>{children}</div>;
}
