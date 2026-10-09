export interface NavItem {
  readonly href: string;
  readonly label: string;
}

/**
 * 保護画面のナビゲーション項目(WUI-001)。実装済みの route だけを載せる。
 * 画面を追加するタスク(T-213〜T-217)がここへ項目を足す。
 */
export const NAV_ITEMS: readonly NavItem[] = [
  { href: "/today", label: "今日" },
  { href: "/profile", label: "プロフィール" },
];

/** 現在の path が項目に属するか(`/today` と `/today/...` は一致し、`/todayx` は一致しない)。 */
export function isCurrentPath(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}
