import { authorizeAdmin } from "@habit-app/application";
import type { AdminAccess, Clock } from "@habit-app/application";
import { createPrismaAdminAccountRepository } from "@habit-app/infrastructure";
import { cache } from "react";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";

import { buildAdminMfaPath, sanitizeAdminNextPath } from "@/lib/admin/next-path";

import { decideAdminGuard, type AdminGuardArea } from "./admin-guard";
import { getAuthContainer } from "./auth-container";
import { PATHNAME_HEADER } from "./pathname-header";
import { requireSession } from "./require-session";
import { adminSessionFromAuth } from "./session-actor";

/**
 * 管理者の認可(毎回 DB で判定。ADM-INV-001)。暗号鍵・HMAC 鍵は不要(それらは API の MFA 検証と監査で使う)。
 * 1 リクエスト内の複数の layout から呼ばれても DB を 1 回だけ引くよう `cache` する。
 */
const getAdminAccess = cache(async (): Promise<AdminAccess> => {
  const { auth, prisma } = await getAuthContainer();
  const session = adminSessionFromAuth(await auth());
  // `requireSession` を通った後に呼ぶ前提。session が無ければ管理者ではない扱い(404)にする。
  if (session === null) return { status: "not_admin" };
  const now: Clock = () => new Date();
  return authorizeAdmin(
    { adminRepository: createPrismaAdminAccountRepository(prisma), now },
    { actorUserId: session.userId, mfaVerifiedAt: session.mfaVerifiedAt },
  );
});

async function currentPath(): Promise<string | undefined> {
  return (await headers()).get(PATHNAME_HEADER) ?? undefined;
}

/**
 * `/admin` 配下の Server Component 用ガード(ADS-001)。未認証は login へ、Admin でなければ 404、
 * MFA の状態に応じて検証画面/トップへ redirect する。保護は UX のためで、データの保護は API が担う。
 */
export async function requireAdminArea(area: AdminGuardArea): Promise<void> {
  await requireSession();
  const access = await getAdminAccess();
  const outcome = decideAdminGuard(access.status, area);
  switch (outcome) {
    case "render":
      return;
    case "not_found":
      return notFound();
    case "redirect_mfa":
      return redirect(buildAdminMfaPath(await currentPath()));
    case "redirect_home":
      return redirect(sanitizeAdminNextPath(await mfaNextParam()));
    default: {
      const unreachable: never = outcome;
      return unreachable;
    }
  }
}

/** `/admin/mfa?next=…` の `next`(現在の path の query から取り出す)。 */
async function mfaNextParam(): Promise<string | undefined> {
  const current = await currentPath();
  if (current === undefined) return undefined;
  const queryStart = current.indexOf("?");
  if (queryStart === -1) return undefined;
  return new URLSearchParams(current.slice(queryStart + 1)).get("next") ?? undefined;
}
