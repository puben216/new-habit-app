import Link from "next/link";
import type { ReactNode } from "react";

import styles from "./form-layout.module.css";

/** フォーム内の縦並び(項目、操作)の共通余白。 */
export function FormStack({ children }: { children: ReactNode }) {
  return <div className={styles["stack"]}>{children}</div>;
}

export interface FormLink {
  readonly href: string;
  readonly label: string;
}

/** フォームの下に置く補助リンク(別画面への導線)。 */
export function FormLinks({ links }: { links: readonly FormLink[] }) {
  return (
    <ul className={styles["links"]}>
      {links.map((link) => (
        <li key={link.href}>
          <Link href={link.href} className={styles["link"]}>
            {link.label}
          </Link>
        </li>
      ))}
    </ul>
  );
}
