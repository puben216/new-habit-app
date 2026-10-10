import { expect, test, type Page } from "@playwright/test";

import { signUpAndSignIn } from "./support/auth";

/** T-217 の E2E: 通知設定画面(docs/specs/notification-screen.md)。 */

function alertIn(page: Page) {
  return page.getByRole("main").getByRole("alert");
}

function panel(page: Page) {
  return page.getByRole("region", { name: "現在の状態" });
}

async function save(page: Page) {
  await page.getByRole("button", { name: "設定を保存" }).click();
  await expect(page.getByRole("status").filter({ hasText: "保存しました。" })).toBeVisible();
}

async function apiSettings(page: Page) {
  return (await (await page.request.get("/api/v1/notification-settings")).json()) as {
    enabled: boolean;
    localTime: string;
    updatedAt: string | null;
    quietHours: { start: string; end: string } | null;
  };
}

test("未保存の Member は停止中として既定値を見て、画面を開いても有効にならない", async ({
  page,
  context,
}) => {
  await signUpAndSignIn(context);
  await page.goto("/notifications");

  await expect(panel(page)).toContainText("リマインドメール: 停止中(まだ設定していません)");
  await expect(page.getByLabel("送信時刻")).toHaveValue("20:00");
  await expect(page.getByLabel("送らない時間帯を設定する")).toBeChecked();
  await expect(page.getByLabel("開始")).toHaveValue("22:00");
  await expect(page.getByLabel("終了")).toHaveValue("07:00");
  await expect(page.getByRole("button", { name: "通知を有効にする" })).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "メインメニュー" }).getByRole("link", { name: "通知" }),
  ).toHaveAttribute("aria-current", "page");

  const settings = await apiSettings(page);
  expect(settings.enabled).toBe(false);
  expect(settings.updatedAt).toBeNull();
});

test("設定の保存だけでは有効にならず、「通知を有効にする」で有効になり、再読み込み後も残る", async ({
  page,
  context,
}) => {
  await signUpAndSignIn(context);
  await page.goto("/notifications");

  await page.getByLabel("送信時刻").fill("07:30");
  await save(page);
  await expect(panel(page)).toContainText("リマインドメール: 停止中");
  expect((await apiSettings(page)).enabled).toBe(false);

  await page.getByRole("button", { name: "通知を有効にする" }).click();
  await expect(panel(page)).toContainText("リマインドメール: 有効");
  await expect(panel(page).getByRole("status")).toHaveText("有効にしました。");

  await page.reload();
  await expect(panel(page)).toContainText("リマインドメール: 有効");
  await expect(page.getByLabel("送信時刻")).toHaveValue("07:30");
});

test("停止と再開は設定を保持し、入力し直す必要がない", async ({ page, context }) => {
  await signUpAndSignIn(context);
  await page.goto("/notifications");
  await page.getByLabel("送信時刻").fill("07:30");
  await page.getByLabel("送らない時間帯を設定する").uncheck();
  await save(page);
  await page.getByRole("button", { name: "通知を有効にする" }).click();
  await expect(panel(page)).toContainText("リマインドメール: 有効");

  await page.getByRole("button", { name: "通知を停止する" }).click();
  await expect(panel(page)).toContainText("リマインドメール: 停止中");
  await expect(panel(page).getByRole("status")).toContainText("停止しました。");
  const stopped = await apiSettings(page);
  expect(stopped).toMatchObject({ enabled: false, localTime: "07:30", quietHours: null });

  await page.getByRole("button", { name: "通知を有効にする" }).click();
  await expect(panel(page)).toContainText("リマインドメール: 有効");
  expect(await apiSettings(page)).toMatchObject({
    enabled: true,
    localTime: "07:30",
    quietHours: null,
  });
});

test("有効なとき送信時刻が送らない時間帯内だと server が拒否し、固定文言を出す。停止中なら保存できる", async ({
  page,
  context,
}) => {
  await signUpAndSignIn(context);
  await page.goto("/notifications");
  await page.getByRole("button", { name: "通知を有効にする" }).click();
  await expect(panel(page)).toContainText("リマインドメール: 有効");

  await page.getByLabel("送信時刻").fill("23:00");
  await page.getByRole("button", { name: "設定を保存" }).click();
  await expect(alertIn(page)).toContainText("送信時刻が送らない時間帯に入っています。");
  await expect(alertIn(page)).toBeFocused();
  await expect(page.getByLabel("送信時刻")).toHaveAttribute("aria-invalid", "true");
  expect((await apiSettings(page)).localTime).toBe("20:00");

  // 停止すれば(組み合わせ検査なしで)保存できる。
  await page.getByRole("button", { name: "通知を停止する" }).click();
  await expect(panel(page)).toContainText("リマインドメール: 停止中");
  await save(page);
  expect((await apiSettings(page)).localTime).toBe("23:00");

  // 時刻が時間帯内のままの再開は拒否され、状態は停止中のまま。
  await page.getByRole("button", { name: "通知を有効にする" }).click();
  await expect(panel(page).getByRole("alert")).toContainText("有効にできません");
  await expect(panel(page)).toContainText("リマインドメール: 停止中");
  expect((await apiSettings(page)).enabled).toBe(false);
});

test("未保存の不正な編集があっても停止できる(停止は検証に依存しない)", async ({
  page,
  context,
}) => {
  await signUpAndSignIn(context);
  await page.goto("/notifications");
  await page.getByRole("button", { name: "通知を有効にする" }).click();
  await expect(panel(page)).toContainText("リマインドメール: 有効");

  await page.getByLabel("送信時刻").fill("");
  await page.getByRole("button", { name: "通知を停止する" }).click();

  await expect(panel(page)).toContainText("リマインドメール: 停止中");
  expect((await apiSettings(page)).localTime).toBe("20:00");
  // 編集中の値は保持される。
  await expect(page.getByLabel("送信時刻")).toHaveValue("");
});

test("送信時刻が空、時間帯の開始が空なら request を送らず固定文言のエラーを出す", async ({
  page,
  context,
}) => {
  await signUpAndSignIn(context);
  let puts = 0;
  await page.route("**/api/v1/notification-settings", async (route) => {
    if (route.request().method() === "PUT") puts += 1;
    await route.continue();
  });
  await page.goto("/notifications");

  await page.getByLabel("送信時刻").fill("");
  await page.getByLabel("開始").fill("");
  await page.getByRole("button", { name: "設定を保存" }).click();

  await expect(alertIn(page)).toContainText("送信時刻を入力してください。");
  await expect(alertIn(page)).toContainText("送らない時間帯の開始と終了を入力してください。");
  await expect(alertIn(page)).toBeFocused();
  expect(puts).toBe(0);
});

test("二重クリックしても有効化の request は 1 回だけ送られる", async ({ page, context }) => {
  await signUpAndSignIn(context);
  let puts = 0;
  await page.route("**/api/v1/notification-settings", async (route) => {
    if (route.request().method() === "PUT") {
      puts += 1;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    await route.continue();
  });
  await page.goto("/notifications");

  await page.getByRole("button", { name: "通知を有効にする" }).dblclick();

  await expect(panel(page)).toContainText("リマインドメール: 有効");
  expect(puts).toBe(1);
});

test("他のユーザーの通知設定は見えない", async ({ browser }) => {
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  try {
    await signUpAndSignIn(contextA);
    const pageA = await contextA.newPage();
    await pageA.goto("/notifications");
    // 既定の送らない時間帯(22:00〜07:00)の外の時刻にする。
    await pageA.getByLabel("送信時刻").fill("12:15");
    await save(pageA);
    await pageA.getByRole("button", { name: "通知を有効にする" }).click();
    await expect(panel(pageA)).toContainText("リマインドメール: 有効");

    await signUpAndSignIn(contextB);
    const pageB = await contextB.newPage();
    await pageB.goto("/notifications");
    await expect(panel(pageB)).toContainText("停止中(まだ設定していません)");
    await expect(pageB.getByLabel("送信時刻")).toHaveValue("20:00");
  } finally {
    await contextA.close();
    await contextB.close();
  }
});

test("未認証で /notifications を開くと login へ redirect される", async ({ page }) => {
  await page.goto("/notifications");
  await expect(page).toHaveURL(/\/login\?next=%2Fnotifications$/);
});
