import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import { signUpAndSignIn } from "./support/auth";
import { E2E_BASE_URL } from "./support/e2e-env";

/** T-216 の E2E: ダッシュボード画面(docs/specs/dashboard-screen.md)。 */

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

/** プロフィールの timezone(Asia/Tokyo)での n 日前の暦日。 */
function jstDate(daysAgo: number): string {
  return new Date(Date.now() + 9 * 3_600_000 - daysAgo * 86_400_000).toISOString().slice(0, 10);
}

async function createHabit(
  context: BrowserContext,
  name: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const response = await context.request.post("/api/v1/habits", {
    headers: { Origin: E2E_BASE_URL },
    data: {
      kind: "build",
      name,
      purpose: "p",
      cue: "c",
      minimumAction: "m",
      schedule: { effectiveFrom: "2025-01-01", daysOfWeek: ALL_DAYS, targetCount: 1 },
      ...overrides,
    },
  });
  expect(response.status(), "create habit").toBe(201);
  return ((await response.json()) as { id: string }).id;
}

async function record(
  context: BrowserContext,
  habitId: string,
  daysAgo: number,
  status: "success" | "missed" | "skipped",
) {
  const response = await context.request.put(
    `/api/v1/habits/${habitId}/entries/${jstDate(daysAgo)}`,
    { headers: { Origin: E2E_BASE_URL }, data: { status } },
  );
  expect(response.status(), "record").toBe(200);
}

function overall(page: Page, title: string) {
  return page.getByRole("region", { name: title }).first();
}

test("記録が集計定義どおりに反映される(7日の成功率 33% → 今日を記録して 43%)", async ({
  page,
  context,
}) => {
  await signUpAndSignIn(context);
  const habitId = await createHabit(context, "散歩");
  await record(context, habitId, 1, "success");
  await record(context, habitId, 2, "success");
  await record(context, habitId, 3, "missed");

  await page.goto("/dashboard");
  await expect(
    page
      .getByRole("navigation", { name: "メインメニュー" })
      .getByRole("link", { name: "ダッシュボード" }),
  ).toHaveAttribute("aria-current", "page");

  // 直近7日: 成功2 / 未実施(記録した1 + 未入力の過去3)=4 / 保留(今日)1 → 2/(2+4)=33%
  const week = overall(page, "直近7日");
  await expect(week.getByText("33%")).toBeVisible();
  await expect(week.locator("dt:has-text('成功') + dd")).toHaveText("2");
  await expect(week.locator("dt:has-text('未実施') + dd")).toHaveText("4");
  await expect(week.locator("dt:has-text('スキップ') + dd")).toHaveText("0");
  await expect(week.locator("dt:has-text('保留') + dd")).toHaveText("1");
  await expect(page.getByText("現在 2 回連続(最長 2 回)")).toBeVisible();

  // 今日を「できた」に記録して開き直す。
  await page.goto("/today");
  await page.getByRole("button", { name: "できた" }).click();
  await expect(page.getByText("現在の記録: できた")).toBeVisible();

  await page.getByRole("link", { name: "ダッシュボード" }).click();
  const updated = overall(page, "直近7日");
  await expect(updated.getByText("43%")).toBeVisible();
  await expect(updated.locator("dt:has-text('成功') + dd")).toHaveText("3");
  await expect(updated.locator("dt:has-text('保留') + dd")).toHaveText("0");
  await expect(page.getByText("現在 3 回連続(最長 3 回)")).toBeVisible();
});

test("スキップは成功率の分母に含まれず、連続も切らない", async ({ page, context }) => {
  await signUpAndSignIn(context);
  const habitId = await createHabit(context, "散歩");
  await record(context, habitId, 1, "skipped");
  await record(context, habitId, 2, "success");

  await page.goto("/dashboard");

  const week = overall(page, "直近7日");
  await expect(week.locator("dt:has-text('スキップ') + dd")).toHaveText("1");
  // 成功1 / 未実施(過去未入力の 4 日)4 → 1/5 = 20%(スキップと今日の保留は分母外)
  await expect(week.getByText("20%")).toBeVisible();
  await expect(page.getByText("現在 1 回連続(最長 1 回)")).toBeVisible();
});

test("進行中の習慣がなければ空状態になる", async ({ page, context }) => {
  await signUpAndSignIn(context);
  await page.goto("/dashboard");

  await expect(page.getByText("進行中の習慣がありません")).toBeVisible();
  await expect(page.getByRole("link", { name: "習慣を作る" })).toBeVisible();
});

test("予定機会がまだ確定していない習慣は成功率を出さず 0% と区別する", async ({
  page,
  context,
}) => {
  await signUpAndSignIn(context);
  const jstToday = jstDate(0);
  await createHabit(context, "今日から", {
    schedule: { effectiveFrom: jstToday, daysOfWeek: ALL_DAYS, targetCount: 1 },
  });

  await page.goto("/dashboard");

  await expect(page.getByText("まだ集計できません").first()).toBeVisible();
  await expect(page.getByText("0%")).toHaveCount(0);
});

test("習慣名は詳細へのリンクで、HTML 文字列は文字として表示される。集計の説明を開ける", async ({
  page,
  context,
}) => {
  await signUpAndSignIn(context);
  const id = await createHabit(context, "<b>強調</b>");
  await page.goto("/dashboard");

  await expect(page.locator("main b")).toHaveCount(0);
  await page.getByRole("link", { name: "<b>強調</b>" }).click();
  await expect(page).toHaveURL(new RegExp(`/habits/${id}$`));

  await page.goto("/dashboard");
  await page.getByText("数値の見方").click();
  await expect(page.getByText("成功率 = 成功 ÷(成功 + 未実施)です。")).toBeVisible();
});

test("他のユーザーの集計は見えない", async ({ browser }) => {
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  try {
    await signUpAndSignIn(contextA);
    const habitId = await createHabit(contextA, "Aの習慣");
    await record(contextA, habitId, 1, "success");

    await signUpAndSignIn(contextB);
    const pageB = await contextB.newPage();
    await pageB.goto("/dashboard");

    await expect(pageB.getByText("進行中の習慣がありません")).toBeVisible();
    await expect(pageB.getByText("Aの習慣")).toHaveCount(0);
  } finally {
    await contextA.close();
    await contextB.close();
  }
});

test("未認証で /dashboard を開くと login へ redirect される", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/login\?next=%2Fdashboard$/);
});
