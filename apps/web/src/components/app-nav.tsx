"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import styles from "./app-nav.module.css";
import { NAV_ITEMS, isCurrentPath } from "./nav-items";

export function AppNav() {
  const pathname = usePathname();

  return (
    <nav aria-label="メインメニュー">
      <ul className={styles["list"]}>
        {NAV_ITEMS.map((item) => (
          <li key={item.href}>
            <Link
              href={item.href}
              className={styles["link"]}
              aria-current={isCurrentPath(pathname, item.href) ? "page" : undefined}
            >
              {item.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
