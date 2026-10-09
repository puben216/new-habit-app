import styles from "./skip-link.module.css";

export const MAIN_CONTENT_ID = "main-content";

/** keyboard 利用者が繰り返しのナビゲーションを飛ばして本文へ移動するための link(WCAG 2.4.1)。 */
export function SkipLink() {
  return (
    <a className={styles["skipLink"]} href={`#${MAIN_CONTENT_ID}`}>
      本文へ移動
    </a>
  );
}
