import { expect, test, type Page } from "@playwright/test";

import { createFakeUser, registerVerifiedUser, signUpAndSignIn } from "./support/auth";

/** T-213 の E2E: オンボーディングとプロフィール(docs/specs/profile-screens.md)。 */

function alertIn(page: Page) {
  return page.getByRole("main").getByRole("alert");
}

async function loginViaUi(page: Page, user: { email: string; password: string }) {
  await page.goto("/login");
  await page.getByLabel("メールアドレス", { exact: true }).fill(user.email);
  await page.getByLabel("パスワード", { exact: true }).fill(user.password);
  await page.getByRole("button", { name: "ログイン" }).click();
}

function onboardingDialog(page: Page) {
  return page.getByRole("dialog", { name: "はじめての設定" });
}

test("初回ログインで初回設定のモーダルが表示され、保存すると /today を使え、値が保存される", async ({
  page,
  context,
}) => {
  const user = await registerVerifiedUser(context.request, createFakeUser(), { onboarded: false });

  await loginViaUi(page, user);
  // redirect せず、/today の上に閉じられないモーダルが出る。画面の中身はまだ表示されない。
  await expect(page).toHaveURL(/\/today$/);
  const dialog = onboardingDialog(page);
  await expect(dialog).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "今日" })).toHaveCount(0);

  await dialog.getByLabel("表示名", { exact: true }).fill("たなか");
  await dialog.getByLabel("タイムゾーン").selectOption("America/New_York");
  await dialog.getByRole("button", { name: "はじめる" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/today$/);
  await expect(page.getByRole("heading", { level: 1, name: "今日" })).toBeVisible();

  const me = await (await page.request.get("/api/v1/me")).json();
  expect(me.displayName).toBe("たなか");
  expect(me.timezone).toBe("America/New_York");
});

test("未完了のまま他の保護画面を開いても URL は変わらず、モーダルが表示され、保存すると同じ画面が表示される", async ({
  page,
  context,
}) => {
  await signUpAndSignIn(context, createFakeUser(), { onboarded: false });

  for (const path of ["/today", "/habits", "/profile"]) {
    await page.goto(path);
    await expect(page, path).toHaveURL(new RegExp(`${path}$`));
    await expect(onboardingDialog(page), path).toBeVisible();
  }

  await page.goto("/habits");
  const dialog = onboardingDialog(page);
  await dialog.getByLabel("表示名", { exact: true }).fill("はなこ");
  await dialog.getByRole("button", { name: "はじめる" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/habits$/);
  await expect(page.getByRole("heading", { level: 1, name: "習慣" })).toBeVisible();
});

test("モーダルは Esc では閉じず、フォーカスはダイアログの外へ出ない", async ({ page, context }) => {
  await signUpAndSignIn(context, createFakeUser(), { onboarded: false });
  await page.goto("/today");
  const dialog = onboardingDialog(page);
  await expect(dialog).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();

  // Tab を繰り返しても、フォーカスは背後の要素(ナビゲーションなど)へ移らない。ダイアログ内を巡回し、
  // 最後の要素を越えたときはブラウザ自身の UI へ出る(ページ内では `body` がフォーカスを持つ状態)。
  for (let i = 0; i < 12; i += 1) {
    await page.keyboard.press("Tab");
    const focusStaysInModal = await page.evaluate(() => {
      const active = document.activeElement;
      return active === null || active === document.body || active.closest("dialog[open]") !== null;
    });
    expect(focusStaysInModal, `Tab ${i + 1} 回目`).toBe(true);
  }
  // 背後のナビゲーションは操作できない(クリックはダイアログに遮られる)。
  await expect(
    page.getByRole("link", { name: "習慣" }).click({ timeout: 1_500 }),
  ).rejects.toThrow();
  await expect(page).toHaveURL(/\/today$/);
  await expect(dialog).toBeVisible();
});

test("専用ページ /onboarding でも同じ設定ができ、保存すると /today へ進む", async ({
  page,
  context,
}) => {
  await signUpAndSignIn(context, createFakeUser(), { onboarded: false });
  await page.goto("/onboarding");
  await expect(page.getByRole("heading", { level: 1, name: "はじめての設定" })).toBeVisible();
  await page.getByLabel("表示名", { exact: true }).fill("たろう");
  await page.getByRole("button", { name: "はじめる" }).click();
  await expect(page).toHaveURL(/\/today$/);
  await expect(page.getByRole("heading", { level: 1, name: "今日" })).toBeVisible();
});

test("完了済みの Member が /onboarding を開くと /today へ戻される", async ({ page, context }) => {
  await signUpAndSignIn(context);

  await page.goto("/onboarding");
  await expect(page).toHaveURL(/\/today$/);
});

test("プロフィールを編集して保存でき、再読み込み後も残る", async ({ page, context }) => {
  await signUpAndSignIn(context);
  await page.goto("/profile");
  await expect(page.getByRole("link", { name: "プロフィール" })).toHaveAttribute(
    "aria-current",
    "page",
  );

  await page.getByLabel("表示名", { exact: true }).fill("新しい名前");
  await page.getByLabel("タイムゾーン").selectOption("UTC");
  await page.getByLabel("週の開始曜日").selectOption("0");
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.getByRole("status").filter({ hasText: "保存しました。" })).toBeVisible();

  await page.reload();
  await expect(page.getByLabel("表示名", { exact: true })).toHaveValue("新しい名前");
  await expect(page.getByLabel("タイムゾーン")).toHaveValue("UTC");
  await expect(page.getByLabel("週の開始曜日")).toHaveValue("0");
});

test("表示名が空・51 文字は request を送らず固定文言のエラーを出す", async ({ page, context }) => {
  await signUpAndSignIn(context);
  let patches = 0;
  await page.route("**/api/v1/me", async (route) => {
    if (route.request().method() === "PATCH") patches += 1;
    await route.continue();
  });
  await page.goto("/profile");

  const name = page.getByLabel("表示名", { exact: true });
  await name.fill("");
  await page.getByRole("button", { name: "保存" }).click();
  await expect(alertIn(page)).toContainText("表示名を入力してください。");
  await expect(alertIn(page)).toBeFocused();
  await expect(name).toHaveAttribute("aria-invalid", "true");

  await name.fill("あ".repeat(51));
  await page.getByRole("button", { name: "保存" }).click();
  await expect(alertIn(page)).toContainText("表示名は50文字以内で入力してください。");
  expect(patches).toBe(0);
});

test("server が拒否した場合も固定の文言で、server の文言は出さない", async ({ page, context }) => {
  await signUpAndSignIn(context);
  await page.route("**/api/v1/me", async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    await route.fulfill({
      status: 422,
      contentType: "application/json",
      body: JSON.stringify({
        code: "validation_failed",
        message: "SECRET internal",
        fieldErrors: { timezone: ["SECRET timezone detail"] },
        requestId: "r1",
      }),
    });
  });
  await page.goto("/profile");

  await page.getByRole("button", { name: "保存" }).click();

  await expect(alertIn(page)).toContainText("タイムゾーンを選び直してください。");
  await expect(page.getByRole("main")).not.toContainText("SECRET");
});

test("表示名の HTML 文字列は文字として表示され、解釈されない", async ({ page, context }) => {
  await signUpAndSignIn(context);
  await page.goto("/profile");

  await page.getByLabel("表示名", { exact: true }).fill("<b>x</b>");
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.getByRole("status").filter({ hasText: "保存しました。" })).toBeVisible();

  await page.reload();
  await expect(page.getByLabel("表示名", { exact: true })).toHaveValue("<b>x</b>");
  await expect(page.locator("main b")).toHaveCount(0);
});

test("他のユーザーのプロフィールは見えず、各自の表示名だけが表示される", async ({ browser }) => {
  const names = ["ユーザーA", "ユーザーB"];
  const pages: Page[] = [];
  const contexts = [await browser.newContext(), await browser.newContext()];
  try {
    for (const [index, context] of contexts.entries()) {
      await signUpAndSignIn(context);
      const page = await context.newPage();
      pages.push(page);
      await page.goto("/profile");
      await page.getByLabel("表示名", { exact: true }).fill(names[index] ?? "");
      await page.getByRole("button", { name: "保存" }).click();
      await expect(page.getByRole("status").filter({ hasText: "保存しました。" })).toBeVisible();
    }
    for (const [index, page] of pages.entries()) {
      await page.reload();
      await expect(page.getByLabel("表示名", { exact: true })).toHaveValue(names[index] ?? "");
    }
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});

test("未認証で /onboarding と /profile を開くと login へ redirect される", async ({ page }) => {
  await page.goto("/profile");
  await expect(page).toHaveURL(/\/login\?next=%2Fprofile$/);
  await page.goto("/onboarding");
  await expect(page).toHaveURL(/\/login\?next=%2Fonboarding$/);
});
