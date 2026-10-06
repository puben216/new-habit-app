import type { ReactNode } from "react";

import { MAIN_CONTENT_ID } from "./skip-link";
import styles from "./main-content.module.css";

/** skip link の移動先。`tabIndex={-1}` で programmatic focus だけを受ける。 */
export function MainContent({ children }: { children: ReactNode }) {
  return (
    <main id={MAIN_CONTENT_ID} tabIndex={-1} className={styles["main"]}>
      {children}
    </main>
  );
}
