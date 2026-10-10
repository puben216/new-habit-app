import type { AdminAccess } from "@habit-app/application";

/**
 * 管理画面のガード(docs/specs/admin-screens.md ADS-001)。判定自体は Application の `authorizeAdmin` が行い、
 * ここでは結果に応じた画面の振り分けだけを決める(業務判断を持たない。ADS-INV-001)。
 *
 * - `shell`: `/admin` 配下の共通 layout。Admin でなければ 404(存在の秘匿。ADS-INV-002)。
 * - `verified`: MFA 検証済みが必要な画面。未検証/期限切れは検証画面へ。
 * - `mfa`: 検証画面。検証済みなら入力不要なので戻す。
 */
export type AdminGuardArea = "shell" | "verified" | "mfa";
export type AdminGuardOutcome = "render" | "not_found" | "redirect_mfa" | "redirect_home";

export function decideAdminGuard(
  status: AdminAccess["status"],
  area: AdminGuardArea,
): AdminGuardOutcome {
  if (status === "not_admin") return "not_found";
  switch (area) {
    case "shell":
      return "render";
    case "verified":
      return status === "granted" ? "render" : "redirect_mfa";
    case "mfa":
      return status === "granted" ? "redirect_home" : "render";
    default: {
      const unreachable: never = area;
      return unreachable;
    }
  }
}
