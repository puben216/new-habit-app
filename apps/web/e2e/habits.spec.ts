import { expect, test, type Page } from "@playwright/test";

import { signUpAndSignIn } from "./support/auth";
import { E2E_BASE_URL } from "./support/e2e-env";

/** T-214 の E2E: 習慣管理画面(docs/specs/habit-screens.md)。 */

function alertIn(page: Page) {
  return page.getByRole("main").getByRole("alert");
}

async function fillBasics(page: Page, name: string) {
  await page.getByLabel("名前", { exact: true }).fill(name);
  await page.getByLabel("目的", { exact: true }).fill("健康のため");
  await page.getByLabel("きっかけ", { exact: true }).fill("朝食のあと");
  await page.getByLabel("最小の行動", { exact: true }).fill("玄関を出る");
}

async function chooseDays(page: Page, days: string[]) {
  for (const day of days) await page.getByLabel(day, { exact: true }).check();
}

async function createBuild(page: Page, name: string): Promise<string> {
  await page.goto("/habits/new");
  await fillBasics(page, name);
  await chooseDays(page, ["月曜日", "水曜日"]);
  await page.getByLabel("1日の回数").fill("2");
  await page.getByRole("button", { name: "習慣を作る" }).click();
  await expect(page).toHaveURL(/\/habits\/[0-9a-f-]{36}$/);
  return page.url().split("/").pop() ?? "";
}

test("build の習慣を作成すると詳細に遷移し、一覧に表示される", async ({ page, context }) => {
  await signUpAndSignIn(context);

  await createBuild(page, "朝の散歩");
  await expect(page.getByRole("heading", { level: 1, name: "朝の散歩" })).toBeVisible();
  await expect(page.getByText("月・水")).toBeVisible();
  await expect(page.getByText("(1日2回)")).toBeVisible();

  await page.goto("/habits");
  await expect(page.getByRole("link", { name: "朝の散歩" })).toBeVisible();
  await expect(page.getByRole("link", { name: "習慣", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
});

test("reduce は回数欄がなく、代わりの行動を入力でき、回数 1 で作成される", async ({
  page,
  context,
}) => {
  await signUpAndSignIn(context);
  await page.goto("/habits/new");

  await page.getByLabel("減らしたい習慣").check();
  await expect(page.getByLabel("1日の回数")).toHaveCount(0);
  await fillBasics(page, "夜更かしを減らす");
  await page.getByLabel("代わりの行動(任意)").fill("本を読む");
  await chooseDays(page, ["日曜日"]);
  await page.getByRole("button", { name: "習慣を作る" }).click();

  await expect(page).toHaveURL(/\/habits\/[0-9a-f-]{36}$/);
  await expect(page.getByLabel("代わりの行動(任意)")).toHaveValue("本を読む");
  await expect(page.getByText("(1日1回)")).toHaveCount(0); // reduce は回数を表示しない
  const id = page.url().split("/").pop();
  const habit = await (await page.request.get(`/api/v1/habits/${id}`)).json();
  expect(habit.kind).toBe("reduce");
  expect(habit.scheduleVersions[0].targetCount).toBe(1);
});

test("入力エラーは request を送らず、要約にフォーカスして項目に説明を付ける", async ({
  page,
  context,
}) => {
  await signUpAndSignIn(context);
  let posts = 0;
  await page.route("**/api/v1/habits", async (route) => {
    if (route.request().method() === "POST") posts += 1;
    await route.continue();
  });
  await page.goto("/habits/new");

  await page.getByRole("button", { name: "習慣を作る" }).click();

  await expect(alertIn(page)).toBeFocused();
  await expect(alertIn(page)).toContainText("名前を入力してください。");
  await expect(alertIn(page)).toContainText("曜日を1つ以上選んでください。");
  await expect(page.getByLabel("名前", { exact: true })).toHaveAttribute("aria-invalid", "true");
  expect(posts).toBe(0);
});

test("詳細を編集して保存でき、再読み込み後も残る。変更がなければ送らない", async ({
  page,
  context,
}) => {
  await signUpAndSignIn(context);
  await createBuild(page, "朝の散歩");

  await page.getByRole("button", { name: "保存" }).click();
  await expect(alertIn(page)).toContainText("変更がありません。");

  await page.getByLabel("名前", { exact: true }).fill("夕方の散歩");
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.getByRole("status").filter({ hasText: "保存しました。" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "夕方の散歩" })).toBeVisible();

  await page.reload();
  await expect(page.getByLabel("名前", { exact: true })).toHaveValue("夕方の散歩");
});

test("スケジュール: 今日が開始日のスケジュールを同日に変えると固定文言で拒否され、翌日開始なら追加できる", async ({
  page,
  context,
}) => {
  await signUpAndSignIn(context);
  await createBuild(page, "朝の散歩");

  await chooseDays(page, ["金曜日"]);
  await page.getByRole("button", { name: "保存" }).click();
  await expect(alertIn(page)).toContainText(
    "適用開始日は、現在のスケジュールの開始日より後の日付にしてください。",
  );

  const tomorrow = await page.evaluate(() => {
    const d = new Date();
    d.setDate(d.getDate() + 2);
    return d.toISOString().slice(0, 10);
  });
  await page.getByLabel("適用開始日").fill(tomorrow);
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.getByRole("status").filter({ hasText: "保存しました。" })).toBeVisible();
  await expect(
    page.getByRole("region", { name: "スケジュールの履歴" }).getByRole("listitem"),
  ).toHaveCount(2);
});

test("更新競合: 別タブの保存後に保存すると競合が表示され、読み込み後に再保存できる", async ({
  page,
  context,
}) => {
  await signUpAndSignIn(context);
  await createBuild(page, "朝の散歩");
  const url = page.url();

  const other = await context.newPage();
  await other.goto(url);
  await other.getByLabel("名前", { exact: true }).fill("別タブの名前");
  await other.getByRole("button", { name: "保存" }).click();
  await expect(other.getByRole("status").filter({ hasText: "保存しました。" })).toBeVisible();

  await page.getByLabel("名前", { exact: true }).fill("元のタブの名前");
  await page.getByRole("button", { name: "保存" }).click();

  await expect(alertIn(page)).toContainText(
    "他の場所で更新されました。最新の内容を読み込んでから、もう一度保存してください。",
  );
  // 入力は保持されている。
  await expect(page.getByLabel("名前", { exact: true })).toHaveValue("元のタブの名前");

  await page.getByRole("button", { name: "最新の内容を読み込む" }).click();
  await expect(page.getByLabel("名前", { exact: true })).toHaveValue("別タブの名前");

  await page.getByLabel("名前", { exact: true }).fill("最終的な名前");
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.getByRole("status").filter({ hasText: "保存しました。" })).toBeVisible();
});

test("アーカイブ: 確認を経て一覧から消え、アーカイブ済みに表示され、編集できない", async ({
  page,
  context,
}) => {
  await signUpAndSignIn(context);
  await createBuild(page, "朝の散歩");
  const url = page.url();

  await page.getByRole("button", { name: "アーカイブ", exact: true }).click();
  await page.getByRole("button", { name: "やめる" }).click();
  await expect(page.getByRole("button", { name: "アーカイブする" })).toHaveCount(0);

  await page.getByRole("button", { name: "アーカイブ", exact: true }).click();
  await page.getByRole("button", { name: "アーカイブする" }).click();
  await expect(page).toHaveURL(/\/habits$/);
  await expect(page.getByRole("link", { name: "朝の散歩" })).toHaveCount(0);
  await expect(page.getByText("進行中の習慣はまだありません")).toBeVisible();

  await page.getByRole("link", { name: "アーカイブ済み" }).click();
  await expect(page.getByRole("link", { name: "朝の散歩" })).toBeVisible();

  await page.goto(url);
  await expect(page.getByText("アーカイブ済みのため、変更できません。")).toBeVisible();
  await expect(page.getByLabel("名前", { exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "保存" })).toHaveCount(0);
});

test("他ユーザーの習慣は一覧にも詳細にも現れない", async ({ browser }) => {
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  try {
    await signUpAndSignIn(contextA);
    const pageA = await contextA.newPage();
    const id = await createBuild(pageA, "Aだけの習慣");

    await signUpAndSignIn(contextB);
    const pageB = await contextB.newPage();
    await pageB.goto("/habits");
    await expect(pageB.getByText("進行中の習慣はまだありません")).toBeVisible();
    await expect(pageB.getByText("Aだけの習慣")).toHaveCount(0);

    await pageB.goto(`/habits/${id}`);
    await expect(
      pageB.getByRole("heading", { level: 1, name: "習慣が見つかりません" }),
    ).toBeVisible();
    await expect(pageB.getByText("Aだけの習慣")).toHaveCount(0);

    // UUID でない ID も同じ表示。
    await pageB.goto("/habits/not-a-uuid");
    await expect(
      pageB.getByRole("heading", { level: 1, name: "習慣が見つかりません" }),
    ).toBeVisible();
  } finally {
    await contextA.close();
    await contextB.close();
  }
});

test("名前の HTML 文字列は文字として表示され、解釈されない", async ({ page, context }) => {
  await signUpAndSignIn(context);
  await createBuild(page, "<b>強調</b>");

  await expect(page.getByRole("heading", { level: 1, name: "<b>強調</b>" })).toBeVisible();
  await expect(page.locator("main b")).toHaveCount(0);
});

test("二重クリックしても作成の request は 1 回だけ送られる", async ({ page, context }) => {
  await signUpAndSignIn(context);
  let posts = 0;
  await page.route("**/api/v1/habits", async (route) => {
    if (route.request().method() === "POST") {
      posts += 1;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    await route.continue();
  });
  await page.goto("/habits/new");
  await fillBasics(page, "二重送信");
  await chooseDays(page, ["火曜日"]);

  await page.getByRole("button", { name: "習慣を作る" }).dblclick();

  await expect(page).toHaveURL(/\/habits\/[0-9a-f-]{36}$/);
  expect(posts).toBe(1);
});

test("一覧は 20 件を超えると「さらに表示」で続きを読み込める", async ({ page, context }) => {
  await signUpAndSignIn(context);
  for (let index = 0; index < 21; index += 1) {
    const response = await context.request.post("/api/v1/habits", {
      headers: { Origin: E2E_BASE_URL },
      data: {
        kind: "build",
        name: `習慣${String(index).padStart(2, "0")}`,
        purpose: "p",
        cue: "c",
        minimumAction: "m",
        schedule: { effectiveFrom: "2026-10-01", daysOfWeek: [1], targetCount: 1 },
      },
    });
    expect(response.status()).toBe(201);
  }

  await page.goto("/habits");
  await expect(page.getByRole("main").getByRole("listitem")).toHaveCount(20);
  await page.getByRole("button", { name: "さらに表示" }).click();
  await expect(page.getByRole("main").getByRole("listitem")).toHaveCount(21);
  await expect(page.getByRole("button", { name: "さらに表示" })).toHaveCount(0);
});

test("未認証で /habits を開くと login へ redirect される", async ({ page }) => {
  await page.goto("/habits");
  await expect(page).toHaveURL(/\/login\?next=%2Fhabits$/);
});
