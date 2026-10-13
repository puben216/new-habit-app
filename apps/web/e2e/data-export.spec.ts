import { readFile } from "node:fs/promises";

import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import { expireReadyExports, exportAuditActions } from "./support/account";
import { userPublicId } from "./support/admin";
import { signInExisting, signUpAndSignIn, type E2eUser } from "./support/auth";
import { E2E_BASE_URL } from "./support/e2e-env";
import { readStoredZip } from "./support/zip";

/** T-404 PR-B の E2E: データエクスポート(docs/specs/data-export.md)。 */

const SENTINEL_NOTE = "=1+1";
const HOST = { Origin: E2E_BASE_URL };

function alertIn(page: Page) {
  return page.getByRole("main").getByRole("alert");
}

async function seedData(context: BrowserContext, habitName: string): Promise<void> {
  const habit = await context.request.post("/api/v1/habits", {
    headers: HOST,
    data: {
      kind: "build",
      name: habitName,
      purpose: "p",
      cue: "朝食のあと",
      minimumAction: "一歩だけ",
      schedule: { effectiveFrom: "2025-01-01", daysOfWeek: [0, 1, 2, 3, 4, 5, 6], targetCount: 1 },
    },
  });
  expect(habit.status(), "create habit").toBe(201);
  const today = (
    (await (await context.request.get("/api/v1/schedule/today")).json()) as { date: string }
  ).date;
  const checkIn = await context.request.put(`/api/v1/daily-check-ins/${today}`, {
    headers: HOST,
    data: { mood: 4, difficulty: 2, note: SENTINEL_NOTE },
  });
  expect(checkIn.status(), "check-in").toBe(200);
}

interface ExportItem {
  id: string;
  status: string;
  format: string;
}

async function listExports(context: BrowserContext): Promise<ExportItem[]> {
  const response = await context.request.get("/api/v1/me/exports");
  expect(response.status(), "list exports").toBe(200);
  return ((await response.json()) as { items: ExportItem[] }).items;
}

/** API で作成する(再認証あり)。 */
async function createViaApi(
  context: BrowserContext,
  user: E2eUser,
  format: "json" | "csv",
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await context.request.post("/api/v1/me/exports", {
    headers: HOST,
    data: { password: user.password, format },
  });
  return { status: response.status(), body: (await response.json()) as Record<string, unknown> };
}

async function waitUntilReady(context: BrowserContext, id: string): Promise<void> {
  await expect
    .poll(async () => (await listExports(context)).find((item) => item.id === id)?.status, {
      timeout: 20_000,
    })
    .toBe("ready");
}

test("UI から JSON を作成してダウンロードでき、自分のデータだけが入り、機密値は入らない", async ({
  page,
  context,
}) => {
  const user = await signUpAndSignIn(context);
  await seedData(context, "散歩");
  const publicId = await userPublicId(user.email);

  // 導線: プロフィール → エクスポート。
  await page.goto("/profile");
  await page.getByRole("link", { name: "データをエクスポートする" }).click();
  await expect(page).toHaveURL("/account/export");
  await expect(page.getByRole("heading", { level: 1, name: "データのエクスポート" })).toBeVisible();

  // 誤ったパスワードは固定文言で、入力が消える。
  await page.getByLabel("現在のパスワード").fill("wrong-password");
  await page.getByRole("button", { name: "エクスポートを作成する" }).click();
  await expect(alertIn(page)).toContainText("パスワードが正しくありません");
  await expect(page.getByLabel("現在のパスワード")).toHaveValue("");

  // 正しいパスワードで JSON を作成する。完成まで自動で更新される。
  await page.getByLabel("現在のパスワード").fill(user.password);
  await page.getByRole("button", { name: "エクスポートを作成する" }).click();
  await expect(page.getByRole("status").filter({ hasText: "作成を開始しました" })).toBeVisible();
  await expect(page.getByLabel("現在のパスワード")).toHaveValue("");
  const item = page.getByRole("listitem").filter({ hasText: "JSON" }).first();
  await expect(item).toContainText("ダウンロードできます", { timeout: 20_000 });
  await expect(item).toContainText("ダウンロードの期限");

  const downloadPromise = page.waitForEvent("download");
  await item.getByRole("link", { name: "ダウンロード" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^habit-app-export-\d{8}\.json$/);
  const text = await readFile(await download.path(), "utf8");
  const doc = JSON.parse(text) as {
    schemaVersion: number;
    account: { email: string };
    habits: { name: string; scheduleVersions: unknown[] }[];
    dailyCheckIns: { note: string; mood: number }[];
  };
  expect(doc.schemaVersion).toBe(1);
  expect(doc.account.email).toBe(user.email);
  expect(doc.habits.map((h) => h.name)).toEqual(["散歩"]);
  expect(doc.habits[0]?.scheduleVersions).toHaveLength(1);
  // JSON ではメモをそのまま(数式の無害化は CSV のみ)。
  expect(doc.dailyCheckIns[0]).toMatchObject({ note: SENTINEL_NOTE, mood: 4 });
  // 機密値(パスワード・ハッシュ・token・内部 ID)が入っていない。
  expect(text).not.toContain(user.password);
  expect(text).not.toMatch(/argon2|passwordHash|sessionToken|totp|"userId"/i);

  // 作成とダウンロードが監査に残る。
  expect(await exportAuditActions(publicId)).toEqual([
    "user.export.requested",
    "user.export.downloaded",
  ]);
});

test("CSV は ZIP で、各 CSV が BOM 付き UTF-8 になり、数式になりうる値は無害化される", async ({
  page,
  context,
}) => {
  const user = await signUpAndSignIn(context);
  await seedData(context, "読書");

  await page.goto("/account/export");
  await page.getByLabel(/^CSV/).check();
  await page.getByLabel("現在のパスワード").fill(user.password);
  await page.getByRole("button", { name: "エクスポートを作成する" }).click();
  const item = page.getByRole("listitem").filter({ hasText: "CSV(ZIP)" }).first();
  await expect(item).toContainText("ダウンロードできます", { timeout: 20_000 });

  const downloadPromise = page.waitForEvent("download");
  await item.getByRole("link", { name: "ダウンロード" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^habit-app-export-\d{8}\.zip$/);

  const files = new Map(
    readStoredZip(await readFile(await download.path())).map((f) => [f.name, f.data]),
  );
  expect([...files.keys()]).toEqual([
    "account.csv",
    "profile.csv",
    "habits.csv",
    "habit_schedule_versions.csv",
    "habit_entries.csv",
    "daily_check_ins.csv",
    "weekly_reviews.csv",
    "notification_settings.csv",
    "ai_results.csv",
    "README.txt",
  ]);
  const habits = files.get("habits.csv") ?? Buffer.alloc(0);
  expect([...habits.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  const habitsText = habits.subarray(3).toString("utf8");
  expect(habitsText.split("\r\n")[0]).toBe(
    "id,kind,name,purpose,cue,minimumAction,replacementAction,status,createdAt,updatedAt",
  );
  expect(habitsText).toContain("読書");
  // 数式として実行されうる値は、先頭に ' を付けて無害化される。
  const checkIns = (files.get("daily_check_ins.csv") ?? Buffer.alloc(0))
    .subarray(3)
    .toString("utf8");
  expect(checkIns).toContain(`'${SENTINEL_NOTE}`);
  expect(checkIns).not.toMatch(/,=1\+1/);
  expect((files.get("README.txt") ?? Buffer.alloc(0)).toString("utf8")).toContain(
    "schemaVersion: 1",
  );
});

test("他人のエクスポートは一覧にもダウンロードにも現れず、存在しない ID と同じ 404", async ({
  context,
  browser,
}) => {
  const owner = await signUpAndSignIn(context);
  await seedData(context, "散歩");
  const created = await createViaApi(context, owner, "json");
  expect(created.status).toBe(202);
  const id = created.body["id"] as string;
  await waitUntilReady(context, id);
  expect((await context.request.get(`/api/v1/me/exports/${id}/download`)).status()).toBe(200);

  const other = await browser.newContext();
  try {
    const intruder = await signUpAndSignIn(other);
    expect(await listExports(other)).toEqual([]);
    const stolen = await other.request.get(`/api/v1/me/exports/${id}/download`);
    const missing = await other.request.get(
      "/api/v1/me/exports/00000000-0000-4000-8000-000000000000/download",
    );
    const malformed = await other.request.get("/api/v1/me/exports/not-a-uuid/download");
    for (const response of [stolen, missing, malformed]) {
      expect(response.status()).toBe(404);
      expect(((await response.json()) as { code: string }).code).toBe("export_not_found");
    }
    expect(intruder.email).not.toBe(owner.email);
  } finally {
    await other.close();
  }
});

test("期限(24 時間)を過ぎると 410 になり、画面でも期限切れと表示される", async ({
  page,
  context,
}) => {
  const user = await signUpAndSignIn(context);
  const created = await createViaApi(context, user, "json");
  const id = created.body["id"] as string;
  await waitUntilReady(context, id);

  await expireReadyExports(user.email);
  const response = await context.request.get(`/api/v1/me/exports/${id}/download`);
  expect(response.status()).toBe(410);
  expect(((await response.json()) as { code: string }).code).toBe("export_expired");
  expect((await listExports(context))[0]?.status).toBe("expired");

  await page.goto("/account/export");
  const history = page.getByRole("region", { name: "作成したエクスポート" });
  await expect(history.getByRole("listitem").first()).toContainText("期限が切れました");
  await expect(page.getByRole("link", { name: "ダウンロード" })).toHaveCount(0);
});

test("作成の頻度は 24 時間に 5 件まで。新しく作ると古いものは無効になる", async ({ context }) => {
  const user = await signUpAndSignIn(context);
  const ids: string[] = [];
  for (let i = 0; i < 5; i += 1) {
    const created = await createViaApi(context, user, i % 2 === 0 ? "json" : "csv");
    expect(created.status, `${i + 1} 件目`).toBe(202);
    const id = created.body["id"] as string;
    ids.push(id);
    await waitUntilReady(context, id);
  }
  const sixth = await createViaApi(context, user, "json");
  expect(sixth.status).toBe(429);
  expect(sixth.body["code"]).toBe("export_rate_limited");

  // 新しいものを作ると、古い完成済みは期限を待たずに無効になる(最後の 1 件だけがダウンロードできる)。
  const items = await listExports(context);
  expect(items.filter((item) => item.status === "ready")).toHaveLength(1);
  expect((await context.request.get(`/api/v1/me/exports/${ids[0]}/download`)).status()).toBe(410);
  expect((await context.request.get(`/api/v1/me/exports/${ids[4]}/download`)).status()).toBe(200);
});

test("再認証に失敗すると作成されず、5 回で制限される。未認証と削除予約中は 401", async ({
  context,
  browser,
}) => {
  const user = await signUpAndSignIn(context);
  for (let i = 0; i < 5; i += 1) {
    const response = await context.request.post("/api/v1/me/exports", {
      headers: HOST,
      data: { password: "wrong-password", format: "json" },
    });
    expect(response.status(), `${i + 1} 回目`).toBe(403);
  }
  const limited = await createViaApi(context, user, "json");
  expect(limited.status).toBe(429);
  expect(limited.body["code"]).toBe("too_many_attempts");
  expect(await listExports(context)).toEqual([]);

  // 未認証は 401。
  const anonymous = await browser.newContext();
  try {
    expect((await anonymous.request.get("/api/v1/me/exports")).status()).toBe(401);
    expect(
      (
        await anonymous.request.post("/api/v1/me/exports", {
          headers: HOST,
          data: { password: "x", format: "json" },
        })
      ).status(),
    ).toBe(401);
  } finally {
    await anonymous.close();
  }

  // 削除を要求したユーザーは、再ログインしてもエクスポートを使えない(Member API の一括遮断)。
  const pending = await browser.newContext();
  try {
    const target = await signUpAndSignIn(pending);
    const deletion = await pending.request.delete("/api/v1/me", {
      headers: HOST,
      data: { password: target.password },
    });
    expect(deletion.status()).toBe(200);
    await signInExisting(pending, target);
    expect((await pending.request.get("/api/v1/me/exports")).status()).toBe(401);
  } finally {
    await pending.close();
  }
});
