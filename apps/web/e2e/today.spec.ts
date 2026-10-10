import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import { signUpAndSignIn } from "./support/auth";
import { E2E_BASE_URL } from "./support/e2e-env";

/** T-215 の E2E: 今日の記録とチェックイン(docs/specs/today-screens.md)。 */

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

async function createHabit(
  context: BrowserContext,
  overrides: Record<string, unknown> & { name: string },
): Promise<string> {
  const response = await context.request.post("/api/v1/habits", {
    headers: { Origin: E2E_BASE_URL },
    data: {
      kind: "build",
      purpose: "p",
      cue: "朝食のあと",
      minimumAction: "一歩だけ",
      schedule: { effectiveFrom: "2025-01-01", daysOfWeek: ALL_DAYS, targetCount: 1 },
      ...overrides,
    },
  });
  expect(response.status(), "create habit").toBe(201);
  return ((await response.json()) as { id: string }).id;
}

function card(page: Page, name: string) {
  return page.getByRole("listitem").filter({ has: page.getByRole("heading", { name }) });
}

function alertIn(page: Page) {
  return page.getByRole("main").getByRole("alert");
}

test("build と reduce を記録し、押し直しで訂正できる", async ({ page, context }) => {
  await signUpAndSignIn(context);
  await createHabit(context, { name: "散歩" });
  await createHabit(context, { name: "夜更かし", kind: "reduce", replacementAction: "本を読む" });
  await page.goto("/today");

  const walk = card(page, "散歩");
  await expect(walk).toContainText("現在の記録: 未記録");
  await walk.getByRole("button", { name: "できた" }).click();
  await expect(walk).toContainText("現在の記録: できた");
  await expect(walk.getByRole("button", { name: "できた" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(walk.getByRole("status")).toHaveText("記録しました。");

  // 訂正: 別の操作で上書きされる。
  await walk.getByRole("button", { name: "できなかった" }).click();
  await expect(walk).toContainText("現在の記録: できなかった");
  await expect(walk.getByRole("button", { name: "できた" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );

  await walk.getByRole("button", { name: "スキップ" }).click();
  await expect(walk).toContainText("現在の記録: スキップ");

  const reduce = card(page, "夜更かし");
  await expect(reduce).toContainText("代わりの行動: 本を読む");
  await expect(reduce.getByRole("button", { name: "できた", exact: true })).toHaveCount(0);
  await reduce.getByRole("button", { name: "回避できた" }).click();
  await expect(reduce).toContainText("現在の記録: 回避できた");
  await reduce.getByRole("button", { name: "してしまった" }).click();
  await expect(reduce).toContainText("現在の記録: してしまった");

  // 再読み込み後も残り、記録は 1 習慣 1 件のまま。
  await page.reload();
  await expect(card(page, "散歩")).toContainText("現在の記録: スキップ");
  await expect(card(page, "夜更かし")).toContainText("現在の記録: してしまった");
});

test("目標回数が複数の習慣は途中経過を記録でき、目標以上は server が拒否して固定文言を出す", async ({
  page,
  context,
}) => {
  await signUpAndSignIn(context);
  await createHabit(context, {
    name: "水を飲む",
    schedule: { effectiveFrom: "2025-01-01", daysOfWeek: ALL_DAYS, targetCount: 3 },
  });
  await page.goto("/today");
  const water = card(page, "水を飲む");

  await expect(water.getByRole("button", { name: "途中経過を記録" })).toBeDisabled();
  await water.getByLabel("途中経過の回数").fill("1");
  await water.getByRole("button", { name: "途中経過を記録" }).click();
  await expect(water).toContainText("現在の記録: 途中経過(1/3回)");

  await water.getByLabel("途中経過の回数").fill("3");
  await water.getByRole("button", { name: "途中経過を記録" }).click();
  await expect(water.getByRole("alert")).toContainText("目標回数より少ない回数を入力してください");
  await expect(water).toContainText("現在の記録: 途中経過(1/3回)");

  await water.getByRole("button", { name: "できた" }).click();
  await expect(water).toContainText("現在の記録: できた(3/3回)");
});

test("過去 7 日を選んで補正でき、8 日前は選べず、今日の表示に影響しない", async ({
  page,
  context,
}) => {
  await signUpAndSignIn(context);
  await createHabit(context, { name: "散歩" });
  await page.goto("/today");

  const dates = page.getByRole("navigation", { name: "記録する日" }).getByRole("link");
  await expect(dates).toHaveCount(8);
  await expect(dates.first()).toHaveText("今日");
  await expect(dates.nth(1)).toHaveText("昨日");

  await dates.nth(1).click();
  await expect(page).toHaveURL(/\/today\?date=\d{4}-\d{2}-\d{2}$/);
  await expect(dates.nth(1)).toHaveAttribute("aria-current", "date");
  await card(page, "散歩").getByRole("button", { name: "できた" }).click();
  await expect(card(page, "散歩")).toContainText("現在の記録: できた");

  await dates.first().click();
  await expect(page).toHaveURL(/\/today$/);
  await expect(card(page, "散歩")).toContainText("現在の記録: 未記録");

  await dates.nth(7).click();
  await expect(card(page, "散歩")).toContainText("現在の記録: 未記録");
});

test("範囲外・不正な date クエリは今日を表示する", async ({ page, context }) => {
  await signUpAndSignIn(context);
  await createHabit(context, { name: "散歩" });

  for (const date of ["2000-01-01", "2999-12-31", "abc"]) {
    await page.goto(`/today?date=${date}`);
    await expect(
      page.getByRole("navigation", { name: "記録する日" }).getByRole("link", { name: "今日" }),
    ).toHaveAttribute("aria-current", "date");
  }
});

test("予定のない日は空状態になる", async ({ page, context }) => {
  await signUpAndSignIn(context);
  // 日本時間の明日の曜日だけに予定がある習慣 → 今日は予定なし。
  const jstToday = new Date(Date.now() + 9 * 3_600_000).getUTCDay();
  await createHabit(context, {
    name: "明日だけ",
    schedule: { effectiveFrom: "2025-01-01", daysOfWeek: [(jstToday + 1) % 7], targetCount: 1 },
  });

  await page.goto("/today");

  await expect(page.getByText("この日に予定された習慣はありません")).toBeVisible();
  await expect(page.getByRole("link", { name: "習慣を管理する" })).toBeVisible();
});

test("チェックインを保存でき、再読み込み後も残る。全項目が未設定なら request を送らない", async ({
  page,
  context,
}) => {
  await signUpAndSignIn(context);
  let puts = 0;
  await page.route("**/api/v1/daily-check-ins/*", async (route) => {
    if (route.request().method() === "PUT") puts += 1;
    await route.continue();
  });
  await page.goto("/today");

  await page.getByRole("button", { name: "チェックインを保存" }).click();
  await expect(alertIn(page)).toContainText("気分・難しさ・メモのうち1つ以上入力してください。");
  await expect(alertIn(page)).toBeFocused();
  expect(puts).toBe(0);

  await page.getByRole("group", { name: "気分" }).getByLabel("4").check();
  await page.getByRole("group", { name: "今日の難しさ" }).getByLabel("2").check();
  await page.getByLabel("メモ").fill("よく眠れた\n散歩した");
  await page.getByRole("button", { name: "チェックインを保存" }).click();
  await expect(page.getByRole("status").filter({ hasText: "保存しました。" })).toBeVisible();

  await page.reload();
  await expect(page.getByRole("group", { name: "気分" }).getByLabel("4")).toBeChecked();
  await expect(page.getByRole("group", { name: "今日の難しさ" }).getByLabel("2")).toBeChecked();
  await expect(page.getByLabel("メモ")).toHaveValue("よく眠れた\n散歩した");
});

test("チェックインの項目を未設定に戻して保存できる(置換)", async ({ page, context }) => {
  await signUpAndSignIn(context);
  await page.goto("/today");
  await page.getByRole("group", { name: "気分" }).getByLabel("5").check();
  await page.getByRole("group", { name: "今日の難しさ" }).getByLabel("1").check();
  await page.getByRole("button", { name: "チェックインを保存" }).click();
  await expect(page.getByRole("status").filter({ hasText: "保存しました。" })).toBeVisible();

  await page.getByRole("group", { name: "気分" }).getByLabel("未設定").check();
  await page.getByRole("button", { name: "チェックインを保存" }).click();
  await expect(page.getByRole("status").filter({ hasText: "保存しました。" })).toBeVisible();

  const date = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
  const saved = await (await page.request.get(`/api/v1/daily-check-ins/${date}`)).json();
  expect(saved.mood).toBeNull();
  expect(saved.difficulty).toBe(1);
});

test("メモの HTML 文字列は文字として扱われる", async ({ page, context }) => {
  await signUpAndSignIn(context);
  await page.goto("/today");
  await page.getByLabel("メモ").fill("<b>x</b><script>window.__xss=1</script>");
  await page.getByRole("button", { name: "チェックインを保存" }).click();
  await expect(page.getByRole("status").filter({ hasText: "保存しました。" })).toBeVisible();

  await page.reload();
  await expect(page.getByLabel("メモ")).toHaveValue("<b>x</b><script>window.__xss=1</script>");
  await expect(page.locator("main b")).toHaveCount(0);
  expect(
    await page.evaluate(() => (window as unknown as { __xss?: number }).__xss),
  ).toBeUndefined();
});

test("二重クリックしても記録の request は 1 回だけ送られる", async ({ page, context }) => {
  await signUpAndSignIn(context);
  await createHabit(context, { name: "散歩" });
  let puts = 0;
  await page.route("**/api/v1/habits/*/entries/*", async (route) => {
    puts += 1;
    await new Promise((resolve) => setTimeout(resolve, 500));
    await route.continue();
  });
  await page.goto("/today");

  await card(page, "散歩").getByRole("button", { name: "できた" }).dblclick();

  await expect(card(page, "散歩")).toContainText("現在の記録: できた");
  expect(puts).toBe(1);
});

test("他のユーザーの予定・記録は見えない", async ({ browser }) => {
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  try {
    await signUpAndSignIn(contextA);
    await createHabit(contextA, { name: "Aの習慣" });
    const pageA = await contextA.newPage();
    await pageA.goto("/today");
    await card(pageA, "Aの習慣").getByRole("button", { name: "できた" }).click();
    await expect(card(pageA, "Aの習慣")).toContainText("現在の記録: できた");
    await pageA.getByRole("group", { name: "気分" }).getByLabel("5").check();
    await pageA.getByRole("button", { name: "チェックインを保存" }).click();
    await expect(pageA.getByRole("status").filter({ hasText: "保存しました。" })).toBeVisible();

    await signUpAndSignIn(contextB);
    const pageB = await contextB.newPage();
    await pageB.goto("/today");
    await expect(pageB.getByText("この日に予定された習慣はありません")).toBeVisible();
    await expect(pageB.getByText("Aの習慣")).toHaveCount(0);
    await expect(pageB.getByRole("group", { name: "気分" }).getByLabel("5")).not.toBeChecked();
  } finally {
    await contextA.close();
    await contextB.close();
  }
});

test("未認証の日付指定 API は 401", async ({ request }) => {
  const response = await request.get("/api/v1/schedule/2026-01-01");
  expect(response.status()).toBe(401);
});

test("日付指定 API は範囲外を 422、今日の応答は earliestDate を含む", async ({ page, context }) => {
  await signUpAndSignIn(context);

  const today = await (await page.request.get("/api/v1/schedule/today")).json();
  expect(today.earliestDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  const tooOld = await page.request.get("/api/v1/schedule/2000-01-01");
  expect(tooOld.status()).toBe(422);
  expect((await tooOld.json()).code).toBe("entry_date_out_of_range");
  const invalid = await page.request.get("/api/v1/schedule/2026-02-30");
  expect(invalid.status()).toBe(422);
  const ok = await page.request.get(`/api/v1/schedule/${today.earliestDate}`);
  expect(ok.status()).toBe(200);
});
