"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import styles from "./app-nav.module.css";

const ADMIN_NAV_ITEMS = [
  { href: "/admin", label: "概要", exact: true },
  { href: "/admin/users", label: "ユーザー検索", exact: false },
  { href: "/admin/notifications", label: "通知配送の失敗", exact: false },
  { href: "/admin/ai-jobs", label: "AI ジョブの失敗", exact: false },
] as const;

/** 管理画面専用のナビゲーション。Member 向けのナビゲーションとは別で、Member の画面からは参照されない。 */
export function AdminNav() {
  const pathname = usePathname();

  return (
    <nav aria-label="管理メニュー">
      <ul className={styles["list"]}>
        {ADMIN_NAV_ITEMS.map((item) => {
          const current = item.exact
            ? pathname === item.href
            : pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                className={styles["link"]}
                aria-current={current ? "page" : undefined}
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
