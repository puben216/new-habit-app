import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import {
  auditActions,
  auditRowsContaining,
  disableAdmin,
  expireMfaVerification,
  grantAdmin,
  seedFailedDelivery,
  totpCode,
  userPublicId,
  type ProvisionedAdmin,
} from "./support/admin";
import {
  createFakeUser,
  registerVerifiedUser,
  signInExisting,
  signUpAndSignIn,
} from "./support/auth";
import type { E2eUser } from "./support/auth";

/** T-403 PR-B の E2E: 管理画面(docs/specs/admin-screens.md)。Admin は本物の運用スクリプトで作る。 */

const NOT_FOUND_HEADING = "ページが見つかりません";

interface AdminSession {
  readonly user: E2eUser;
  readonly admin: ProvisionedAdmin;
}

/** 通常の登録・確認・login を済ませたユーザーを Admin にする(MFA は未検証のまま)。 */
async function createAdmin(context: BrowserContext): Promise<AdminSession> {
  const user = await signUpAndSignIn(context);
  return { user, admin: grantAdmin(user.email) };
}

async function submitCode(page: Page, code: string): Promise<void> {
  await page.getByLabel("確認コード").fill(code);
  await page.getByRole("button", { name: "確認する" }).click();
}

/** TOTP で MFA を検証して `path` を開く(未検証なら検証画面を経由して戻る)。 */
async function openVerified(page: Page, session: AdminSession, path: string): Promise<void> {
  await page.goto(path);
  await expect(page).toHaveURL(/\/admin\/mfa/);
  await submitCode(page, totpCode(session.admin.totpSecret));
  await expect(page).toHaveURL(path);
}

test("Member には管理画面が存在せず、通常の 404 と同じ表示になる", async ({ page, context }) => {
  await signUpAndSignIn(context);

  const missing = await page.goto("/this-page-does-not-exist");
  expect(missing?.status()).toBe(404);
  const expectedText = await page.getByRole("main").innerText();
  expect(expectedText).toContain(NOT_FOUND_HEADING);

  for (const path of ["/admin", "/admin/users", "/admin/notifications", "/admin/mfa"]) {
    const response = await page.goto(path);
    expect(response?.status(), path).toBe(404);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(NOT_FOUND_HEADING);
    // 管理画面専用のナビゲーションや文言が含まれない。
    await expect(page.getByRole("navigation", { name: "管理メニュー" })).toHaveCount(0);
    expect(await page.getByRole("main").innerText(), path).toBe(expectedText);
  }
});

test("未認証は login へ移り、元の画面を next に持つ", async ({ page }) => {
  await page.goto("/admin/users");
  await expect(page).toHaveURL(/\/login\?next=%2Fadmin%2Fusers/);
});

test("MFA 未検証の Admin は検証画面へ誘導され、誤ったコードは固定文言で入力が消え、正しいコードで元の画面に戻る", async ({
  page,
  context,
}) => {
  const session = await createAdmin(context);

  await page.goto("/admin/notifications");
  await expect(page).toHaveURL(/\/admin\/mfa\?next=%2Fadmin%2Fnotifications/);
  // 閲覧画面は描画されない。
  await expect(page.getByRole("heading", { level: 1, name: "通知配送の失敗" })).toHaveCount(0);

  await submitCode(page, "000000");
  await expect(page.getByRole("main").getByRole("alert")).toContainText("コードが正しくありません");
  await expect(page.getByLabel("確認コード")).toHaveValue("");
  await expect(page).toHaveURL(/\/admin\/mfa/);

  await submitCode(page, totpCode(session.admin.totpSecret));
  await expect(page).toHaveURL("/admin/notifications");
  await expect(page.getByRole("heading", { level: 1, name: "通知配送の失敗" })).toBeVisible();

  // 検証済みなら検証画面は入力不要で戻される。
  await page.goto("/admin/mfa");
  await expect(page).toHaveURL("/admin");
  await expect(page.getByRole("navigation", { name: "管理メニュー" })).toBeVisible();
});

test("リカバリーコードは一度だけ使え、別の session では再利用できない", async ({
  page,
  context,
  browser,
}) => {
  const session = await createAdmin(context);
  const recoveryCode = session.admin.recoveryCodes[0] ?? "";

  await page.goto("/admin");
  await submitCode(page, recoveryCode);
  await expect(page).toHaveURL("/admin");

  const other = await browser.newContext();
  try {
    await signInExisting(other, session.user);
    const otherPage = await other.newPage();
    await otherPage.goto("/admin");
    await expect(otherPage).toHaveURL(/\/admin\/mfa/);
    await submitCode(otherPage, recoveryCode);
    await expect(otherPage.getByRole("main").getByRole("alert")).toContainText(
      "コードが正しくありません",
    );
    await expect(otherPage).toHaveURL(/\/admin\/mfa/);
  } finally {
    await other.close();
  }
});

test("ユーザー検索はマスク表示で email が URL・storage・監査に残らず、概要も確認できる", async ({
  page,
  context,
}) => {
  const session = await createAdmin(context);
  const target = await registerVerifiedUser(context.request, createFakeUser(), {
    onboarded: false,
  });
  const targetPublicId = await userPublicId(target.email);

  await openVerified(page, session, "/admin/users");
  await expect(page.getByRole("heading", { level: 1, name: "ユーザー検索" })).toBeVisible();

  await page.getByLabel("メールアドレス").fill(target.email);
  await page.getByRole("button", { name: "検索" }).click();
  await expect(page.getByRole("status")).toHaveText("1 件見つかりました。");
  const main = page.getByRole("main");
  await expect(main).toContainText("***@example.test");
  // 全体の email は表示されない(入力欄の値は本文として数えない)。
  await expect(main).not.toContainText(target.email);

  // email が URL と storage に残らない。
  expect(decodeURIComponent(page.url())).not.toContain(target.email);
  const storage = await page.evaluate(() =>
    JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }),
  );
  expect(storage).not.toContain(target.email);

  // 未登録の email は「見つかりませんでした」。
  await page.getByLabel("メールアドレス").fill(`unknown-${targetPublicId}@example.test`);
  await page.getByRole("button", { name: "検索" }).click();
  await expect(page.getByRole("status")).toHaveText("該当するユーザーは見つかりませんでした。");

  // 概要。
  await page.getByLabel("メールアドレス").fill(target.email);
  await page.getByRole("button", { name: "検索" }).click();
  await page.getByRole("link", { name: "概要を見る" }).click();
  await expect(page).toHaveURL(`/admin/users/${targetPublicId}`);
  await expect(page.getByRole("heading", { level: 1, name: "ユーザー概要" })).toBeVisible();
  await expect(main).toContainText("確認済み");
  await expect(main).toContainText(targetPublicId);
  await expect(main).not.toContainText(target.email);

  // 存在しない ID・UUID でない ID は同じ「見つかりません」。
  await page.goto("/admin/users/00000000-0000-4000-8000-000000000000");
  await expect(page.getByRole("heading", { name: "見つかりません" })).toBeVisible();
  await page.goto("/admin/users/not-a-uuid");
  await expect(page.getByRole("heading", { name: "見つかりません" })).toBeVisible();

  // 監査: 検索と閲覧が記録され、email は残らない。
  const actions = await auditActions(`admin:${session.admin.publicId}`);
  expect(actions).toEqual(
    expect.arrayContaining(["admin.mfa.verified", "admin.user.search", "admin.user.view"]),
  );
  expect(await auditRowsContaining(target.email)).toBe(0);
});

test("通知配送の失敗一覧は状態を文字で示し、絞り込みと空状態がある。AI ジョブは空状態", async ({
  page,
  context,
}) => {
  const session = await createAdmin(context);
  const target = await registerVerifiedUser(context.request, createFakeUser(), {
    onboarded: false,
  });
  const targetPublicId = await userPublicId(target.email);
  await seedFailedDelivery(target.email, "rejected");

  await openVerified(page, session, "/admin/notifications");
  const row = page.getByRole("row").filter({ hasText: targetPublicId });
  await expect(row).toContainText("失敗");
  await expect(row).toContainText("rejected");
  await expect(row.getByRole("link", { name: targetPublicId })).toHaveAttribute(
    "href",
    `/admin/users/${targetPublicId}`,
  );

  // 絞り込み: 現在の選択が示され、該当しない状態では対象の行が出ない。
  await page.getByRole("link", { name: "期限切れ" }).click();
  await expect(page).toHaveURL(/status=expired/);
  await expect(page.getByRole("link", { name: "期限切れ" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.getByRole("row").filter({ hasText: targetPublicId })).toHaveCount(0);
  await page.getByRole("link", { name: "失敗", exact: true }).click();
  await expect(page.getByRole("row").filter({ hasText: targetPublicId })).toBeVisible();

  // AI ジョブ(失敗したジョブがなければ空状態)。
  await page.getByRole("link", { name: "AI ジョブの失敗" }).click();
  await expect(page).toHaveURL("/admin/ai-jobs");
  await expect(page.getByRole("heading", { name: "該当するジョブはありません" })).toBeVisible();

  const actions = await auditActions(`admin:${session.admin.publicId}`);
  expect(actions).toEqual(
    expect.arrayContaining(["admin.notifications.list", "admin.ai_jobs.list"]),
  );
});

test("無効化された Admin は次の画面表示から 404 になる", async ({ page, context }) => {
  const session = await createAdmin(context);
  await openVerified(page, session, "/admin");
  await expect(page.getByRole("navigation", { name: "管理メニュー" })).toBeVisible();

  disableAdmin(session.user.email);

  const response = await page.goto("/admin/users");
  expect(response?.status()).toBe(404);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(NOT_FOUND_HEADING);
});

test("誤ったコードが続くとロックされ、正しいコードでもロック中は通らない", async ({
  page,
  context,
}) => {
  const session = await createAdmin(context);
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/admin\/mfa/);

  const alert = page.getByRole("main").getByRole("alert");
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await submitCode(page, "000000");
    await expect(alert).toBeVisible();
  }
  // 5 回目の失敗でロックされ、次の試行はロックの案内になる。
  await submitCode(page, totpCode(session.admin.totpSecret));
  await expect(alert).toContainText("試行回数の上限に達しました");
  await expect(page).toHaveURL(/\/admin\/mfa/);
  await expect(page.getByLabel("確認コード")).toHaveValue("");
});

test("操作中に MFA の有効期限が切れると、次の読み込みで検証画面へ移り、検証後に元の画面へ戻る", async ({
  page,
  context,
}) => {
  const session = await createAdmin(context);
  await openVerified(page, session, "/admin");

  // 同じ session のまま 30 分を過ぎた状態にする(画面は client 遷移なので layout は再評価されない)。
  await expireMfaVerification(session.user.email);
  await page.getByRole("link", { name: "通知配送の失敗" }).first().click();
  await expect(page).toHaveURL(/\/admin\/mfa\?next=%2Fadmin%2Fnotifications/);

  // 直前に受理した TOTP のステップは再利用できないため、リカバリーコードで検証する。
  await submitCode(page, session.admin.recoveryCodes[0] ?? "");
  await expect(page).toHaveURL("/admin/notifications");
  await expect(page.getByRole("heading", { level: 1, name: "通知配送の失敗" })).toBeVisible();
});
