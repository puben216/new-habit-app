import { expect, test } from "@playwright/test";

import { signUpAndSignIn } from "./support/auth";

/** T-211 の smoke: 空のページ、認証ガード、keyboard/focus の基本(docs/specs/web-ui-foundation.md)。 */

test("未認証で保護画面を開くと /login へ redirect され、保護画面は描画されない", async ({
  page,
}) => {
  await page.goto("/today");

  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("heading", { level: 1, name: "ログイン" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "今日" })).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "メインメニュー" })).toHaveCount(0);
});

test("認証済みなら空の保護画面が描画され、現在地がナビゲーションに示される", async ({
  page,
  context,
}) => {
  await signUpAndSignIn(context);

  await page.goto("/today");

  await expect(page).toHaveURL(/\/today$/);
  await expect(page.getByRole("heading", { level: 1, name: "今日" })).toBeVisible();
  await expect(page.getByRole("link", { name: "今日" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("main")).toContainText("準備中");
});

test("skip link を keyboard で操作すると本文へ移動する", async ({ page, context }) => {
  await signUpAndSignIn(context);
  await page.goto("/today");

  await page.keyboard.press("Tab");
  const skipLink = page.getByRole("link", { name: "本文へ移動" });
  await expect(skipLink).toBeFocused();
  await expect(skipLink).toBeInViewport();

  await page.keyboard.press("Enter");
  await expect(page.getByRole("main")).toBeFocused();
});

test("Tab の順序は skip link → ブランド → ナビゲーションで、各 focus が visible である", async ({
  page,
  context,
}) => {
  await signUpAndSignIn(context);
  await page.goto("/today");

  const expectedOrder = ["本文へ移動", "AI Habit Coach", "今日"];
  for (const name of expectedOrder) {
    await page.keyboard.press("Tab");
    const link = page.getByRole("link", { name });
    await expect(link).toBeFocused();
    await expect(link).toBeInViewport();
    const outlineStyle = await link.evaluate((element) => getComputedStyle(element).outlineStyle);
    expect(outlineStyle, `${name} の focus 表示`).not.toBe("none");
  }
});

test("存在しない path は固定文言の not-found(404)になる", async ({ page }) => {
  const response = await page.goto("/no-such-page");

  expect(response?.status()).toBe(404);
  await expect(
    page.getByRole("heading", { level: 1, name: "ページが見つかりません" }),
  ).toBeVisible();
  await expect(page.getByRole("main")).toBeVisible();
  await expect(page.getByRole("link", { name: "トップページへ" })).toBeVisible();
});

test("公開ページは全ページに lang と landmark と h1 を持つ", async ({ page }) => {
  await page.goto("/");

  await expect(page.locator("html")).toHaveAttribute("lang", "ja");
  await expect(page.getByRole("banner")).toBeVisible();
  await expect(page.getByRole("main")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
});
