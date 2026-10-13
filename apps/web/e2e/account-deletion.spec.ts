import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import {
  accountStatusOf,
  ageDeletionRequest,
  auditActionsForTarget,
  runPurgeJob,
  userRowExists,
} from "./support/account";
import { signInExisting, signUpAndSignIn, type E2eUser } from "./support/auth";
import { E2E_BASE_URL } from "./support/e2e-env";
import { userPublicId } from "./support/admin";

/** T-404 PR-A の E2E: アカウント削除(docs/specs/account-deletion.md)。削除ジョブは本物の `pnpm account:purge`。 */

const REQUESTED_BANNER = "アカウントの削除を受け付けました";

function alertIn(page: Page) {
  return page.getByRole("main").getByRole("alert");
}

async function createHabit(context: BrowserContext, name: string): Promise<void> {
  const response = await context.request.post("/api/v1/habits", {
    headers: { Origin: E2E_BASE_URL },
    data: {
      kind: "build",
      purpose: "p",
      cue: "朝食のあと",
      minimumAction: "一歩だけ",
      name,
      schedule: { effectiveFrom: "2025-01-01", daysOfWeek: [0, 1, 2, 3, 4, 5, 6], targetCount: 1 },
    },
  });
  expect(response.status(), "create habit").toBe(201);
}

async function habitNames(context: BrowserContext): Promise<string[]> {
  const response = await context.request.get("/api/v1/habits");
  expect(response.status(), "list habits").toBe(200);
  return ((await response.json()) as { items: { name: string }[] }).items.map((h) => h.name);
}

/** 画面から削除を要求する(確認の 2 段階を通す)。 */
async function requestDeletionViaUi(page: Page, password: string): Promise<void> {
  await page.goto("/account/delete");
  await page.getByLabel("現在のパスワード").fill(password);
  await page.getByRole("button", { name: "確認に進む" }).click();
  await page.getByRole("button", { name: "削除を要求する" }).click();
}

async function fillLogin(page: Page, user: E2eUser): Promise<void> {
  await page.getByLabel("メールアドレス", { exact: true }).fill(user.email);
  await page.getByLabel("パスワード", { exact: true }).fill(user.password);
  await page.getByRole("button", { name: "ログイン" }).click();
}

test("プロフィールから削除を要求し、再ログインで取り消すと、データを失わずに元に戻る", async ({
  page,
  context,
}) => {
  const user = await signUpAndSignIn(context);
  await createHabit(context, "散歩");

  // 導線: プロフィール → 削除画面。
  await page.goto("/profile");
  await page.getByRole("link", { name: "アカウントを削除する" }).click();
  await expect(page).toHaveURL("/account/delete");
  await expect(page.getByRole("heading", { level: 1, name: "アカウントの削除" })).toBeVisible();

  // 要求(2 段階の確認)。成功すると login へ移り、案内が出る。
  await page.getByLabel("現在のパスワード").fill(user.password);
  await page.getByRole("button", { name: "確認に進む" }).click();
  await expect(page.getByText("本当に削除を要求しますか")).toBeVisible();
  await page.getByRole("button", { name: "削除を要求する" }).click();
  await expect(page).toHaveURL(/\/login\?reason=deletion_requested/);
  await expect(page.getByText(REQUESTED_BANNER)).toBeVisible();

  // 全 session が失効している(元の cookie では API を使えない)。
  expect((await context.request.get("/api/v1/habits")).status()).toBe(401);
  expect(await accountStatusOf(user.email)).toBe("deletion_pending");

  // 再ログイン(UI)すると取り消し画面に着く。通常の画面には入れない。
  await fillLogin(page, user);
  await expect(page).toHaveURL("/account/restore");
  await expect(
    page.getByRole("heading", { level: 1, name: "アカウントの削除が予約されています" }),
  ).toBeVisible();
  await expect(page.getByRole("main")).toContainText("UTC");
  await expect(page.getByRole("navigation", { name: "メインメニュー" })).toHaveCount(0);
  for (const path of ["/today", "/habits", "/profile", "/account/delete"]) {
    await page.goto(path);
    await expect(page, path).toHaveURL("/account/restore");
  }

  // 予約中は Member 向けの API が使えず、状態の確認だけができる。
  expect((await page.context().request.get("/api/v1/habits")).status()).toBe(401);
  expect((await page.context().request.get("/api/v1/me")).status()).toBe(401);
  const state = await page.context().request.get("/api/v1/me/deletion");
  expect(state.status()).toBe(200);
  expect(((await state.json()) as { status: string }).status).toBe("deletion_pending");

  // 取り消す。
  await page.getByRole("button", { name: "削除を取り消す" }).click();
  await expect(page).toHaveURL("/today");
  expect(await accountStatusOf(user.email)).toBe("active");
  expect(await habitNames(page.context())).toEqual(["散歩"]);
  expect((await userPublicId(user.email)).length).toBeGreaterThan(0);

  const actions = await auditActionsForTarget(await userPublicId(user.email));
  expect(actions).toEqual(["user.account.deletion_requested", "user.account.deletion_cancelled"]);
});

test("誤ったパスワードは受理されず、入力は消え、5 回続くとロックされる", async ({
  page,
  context,
}) => {
  const user = await signUpAndSignIn(context);
  await createHabit(context, "読書");

  for (let attempt = 0; attempt < 5; attempt += 1) {
    await requestDeletionViaUi(page, "wrong-password");
    await expect(alertIn(page)).toContainText("パスワードが正しくありません");
    await expect(page.getByLabel("現在のパスワード")).toHaveValue("");
  }
  expect(await accountStatusOf(user.email)).toBe("active");

  // 制限中は、正しいパスワードでも受理されない。
  await requestDeletionViaUi(page, user.password);
  await expect(alertIn(page)).toContainText("試行回数の上限に達しました");
  expect(await accountStatusOf(user.email)).toBe("active");
  expect(await habitNames(context)).toEqual(["読書"]);

  // 通常のログインは影響を受けない(別の context で新しい session を得られる)。
  const fresh = await page.context().browser()?.newContext();
  try {
    if (fresh === undefined) throw new Error("browser unavailable");
    await signInExisting(fresh, user);
    expect((await fresh.request.get("/api/v1/habits")).status()).toBe(200);
  } finally {
    await fresh?.close();
  }
});

test("猶予期間を過ぎると取り消せず、削除ジョブで完全に削除される", async ({ page, context }) => {
  const user = await signUpAndSignIn(context);
  await createHabit(context, "散歩");
  const publicId = await userPublicId(user.email);

  await requestDeletionViaUi(page, user.password);
  await expect(page).toHaveURL(/\/login\?reason=deletion_requested/);

  // 猶予の途中(29 日経過)ではジョブは削除しない。
  await ageDeletionRequest(user.email, 29);
  runPurgeJob();
  expect(await userRowExists(user.email)).toBe(true);

  // 30 日を過ぎると、ジョブ未実行でも取り消せない。
  await ageDeletionRequest(user.email, 2);
  await signInExisting(context, user);
  await page.goto("/account/restore");
  await page.getByRole("button", { name: "削除を取り消す" }).click();
  await expect(alertIn(page)).toContainText("猶予期間を過ぎているため、取り消せません");
  expect(await accountStatusOf(user.email)).toBe("deletion_pending");

  // 削除ジョブ(本物の `pnpm account:purge`)で、ユーザーと全データが削除される。
  const summary = runPurgeJob();
  expect(summary.purged).toBeGreaterThanOrEqual(1);
  expect(summary.failed).toBe(0);
  expect(await userRowExists(user.email)).toBe(false);
  expect(await auditActionsForTarget(publicId)).toEqual([
    "user.account.deletion_requested",
    "system.account.purged",
  ]);

  // 削除後は同じ資格情報でログインできない。
  const login = await context.request.post("/api/auth/callback/credentials", {
    form: {
      csrfToken: (
        (await (await context.request.get("/api/auth/csrf")).json()) as { csrfToken: string }
      ).csrfToken,
      email: user.email,
      password: user.password,
      json: "true",
    },
  });
  const session = (await (await context.request.get("/api/auth/session")).json()) as {
    user?: { id?: string };
  };
  expect(login.status() < 500).toBe(true);
  expect(session.user?.id).toBeUndefined();
});

test("削除予約の画面は、削除予約中の session だけが表示できる", async ({ page, context }) => {
  // 未認証は login へ。
  await page.goto("/account/restore");
  await expect(page).toHaveURL(/\/login/);

  // active の Member は通常の画面へ戻される。
  await signUpAndSignIn(context);
  await page.goto("/account/restore");
  await expect(page).toHaveURL("/today");
});
