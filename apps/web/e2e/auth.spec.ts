import { expect, test, type Page } from "@playwright/test";

import {
  PASSWORD_RESET_SUBJECT,
  VERIFY_EMAIL_SUBJECT,
  createFakeUser,
  registerVerifiedUser,
  signUpAndSignIn,
  type E2eUser,
} from "./support/auth";
import { extractTokenFromEmail, waitForEmail } from "./support/mailpit";

/** T-212 の E2E: 認証画面(docs/specs/auth-screens.md)。 */

const LOGIN_FAILED =
  "メールアドレスまたはパスワードが正しくないか、メールアドレスの確認が完了していません。";

async function fillAndSubmit(page: Page, fields: Record<string, string>, button: string) {
  for (const [label, value] of Object.entries(fields)) {
    await page.getByLabel(label, { exact: true }).fill(value);
  }
  await page.getByRole("button", { name: button }).click();
}

/** フォームのエラー要約。Next.js の route announcer(同じく role=alert)を除くため main 内に限定する。 */
function alertIn(page: Page) {
  return page.getByRole("main").getByRole("alert");
}

async function login(page: Page, user: E2eUser) {
  await fillAndSubmit(page, { メールアドレス: user.email, パスワード: user.password }, "ログイン");
}

async function mainText(page: Page): Promise<string> {
  return (await page.getByRole("main").innerText()).trim();
}

test("signup → メール確認 → login → logout の一連を UI だけで完了できる", async ({ page }) => {
  const user = createFakeUser();

  await page.goto("/signup");
  await fillAndSubmit(
    page,
    { メールアドレス: user.email, パスワード: user.password },
    "アカウントを作成",
  );
  await expect(page.getByText("確認メールを送信しました。届いていない場合は")).toBeVisible();
  // 完了表示に入力した email を出さない。
  await expect(page.getByRole("main")).not.toContainText(user.email);

  const message = await waitForEmail({ to: user.email, subject: VERIFY_EMAIL_SUBJECT });
  const token = extractTokenFromEmail(message.text);
  const link = message.text.match(/https?:\/\/\S+/)?.[0];
  expect(link).toBeTruthy();

  // リンクを開いただけでは token を消費しない。ボタンで確認する。
  await page.goto(link as string);
  await page.getByRole("button", { name: "メールアドレスを確認する" }).click();
  await expect(page.getByText("メールアドレスを確認しました")).toBeVisible();
  expect(page.url()).not.toContain(token);

  await page.getByRole("link", { name: "ログインへ" }).click();
  await login(page, user);
  // 初回ログインはオンボーディングへ誘導される(T-213)。
  await expect(page).toHaveURL(/\/onboarding$/);
  await page.getByLabel("表示名", { exact: true }).fill("たなか");
  await page.getByRole("button", { name: "はじめる" }).click();
  await expect(page).toHaveURL(/\/today$/);
  await expect(page.getByRole("heading", { level: 1, name: "今日" })).toBeVisible();

  await page.getByRole("button", { name: "ログアウト" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto("/today");
  await expect(page).toHaveURL(/\/login\?next=%2Ftoday$/);
});

test("login の失敗は理由を区別せず、画面の構成も同一である", async ({ page, context }) => {
  const verified = await registerVerifiedUser(context.request);
  const unverified = createFakeUser();
  const signup = await context.request.post("/api/v1/auth/signup", {
    data: { email: unverified.email, password: unverified.password },
  });
  expect(signup.status()).toBe(202);

  const attempts: Array<{ name: string; user: E2eUser }> = [
    { name: "password 不一致", user: { email: verified.email, password: "wrong-password-0000" } },
    { name: "未登録", user: createFakeUser() },
    { name: "未確認", user: unverified },
  ];

  const bodies: string[] = [];
  for (const attempt of attempts) {
    await page.goto("/login");
    await login(page, attempt.user);
    await expect(alertIn(page)).toContainText(LOGIN_FAILED);
    await expect(page).toHaveURL(/\/login$/);
    bodies.push(await mainText(page));
    // 失敗後に password は空に戻る。
    await expect(page.getByLabel("パスワード", { exact: true })).toHaveValue("");
  }

  expect(new Set(bodies).size, `失敗 3 種の本文が一致する: ${JSON.stringify(bodies)}`).toBe(1);
});

test("signup は登録済みの email でも新規と同じ完了表示になる", async ({ page, context }) => {
  const existing = await registerVerifiedUser(context.request);
  const fresh = createFakeUser();

  const bodies: string[] = [];
  for (const email of [fresh.email, existing.email]) {
    await page.goto("/signup");
    await fillAndSubmit(
      page,
      { メールアドレス: email, パスワード: fresh.password },
      "アカウントを作成",
    );
    await expect(page.getByText("確認メールを送信しました。届いていない場合は")).toBeVisible();
    bodies.push(await mainText(page));
  }

  expect(bodies[1]).toBe(bodies[0]);
});

test("未認証で保護画面を開くと next 付きで login へ移り、成功後に元の画面へ戻る", async ({
  page,
  context,
}) => {
  const user = await registerVerifiedUser(context.request);

  await page.goto("/today?x=1");
  await expect(page).toHaveURL(/\/login\?next=%2Ftoday%3Fx%3D1$/);

  await login(page, user);
  await expect(page).toHaveURL(/\/today\?x=1$/);
});

test("不正な next は無視して /today へ遷移し、外部 origin へは出ない", async ({
  page,
  context,
}) => {
  const user = await registerVerifiedUser(context.request);

  for (const next of [
    "//evil.example",
    "https://evil.example/today",
    "/api/auth/session",
    "/\\evil.example",
  ]) {
    await page.goto(`/login?next=${encodeURIComponent(next)}`);
    await login(page, user);
    await expect(page).toHaveURL(/localhost:\d+\/today$/);
    await page.getByRole("button", { name: "ログアウト" }).click();
    await expect(page).toHaveURL(/\/login$/);
  }
});

test("認証済みユーザーが認証画面を開くと /today へ戻される", async ({ page, context }) => {
  await signUpAndSignIn(context);

  for (const path of ["/login", "/signup", "/password-reset"]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/today$/);
  }
});

test("logout 後は以前の session cookie が server 側で無効になる", async ({
  page,
  context,
  browser,
}) => {
  await signUpAndSignIn(context);
  await page.goto("/today");
  const savedCookies = await context.cookies();
  expect(savedCookies.length).toBeGreaterThan(0);

  await page.getByRole("button", { name: "ログアウト" }).click();
  await expect(page).toHaveURL(/\/login$/);

  const replay = await browser.newContext();
  await replay.addCookies(savedCookies);
  const replayPage = await replay.newPage();
  await replayPage.goto("http://localhost:3100/today");
  await expect(replayPage).toHaveURL(/\/login\?next=%2Ftoday$/);
  await replay.close();
});

test("password reset の一連: 要求 → メールのリンク → 再設定 → 新 password で login、リンクは再利用不可", async ({
  page,
  context,
}) => {
  const user = await registerVerifiedUser(context.request);
  const newPassword = `New-${createFakeUser().password}`;

  await page.goto("/password-reset");
  await fillAndSubmit(page, { メールアドレス: user.email }, "案内を送る");
  await expect(page.getByText("再設定の案内を送信しました(登録がある場合)")).toBeVisible();

  const message = await waitForEmail({ to: user.email, subject: PASSWORD_RESET_SUBJECT });
  const link = message.text.match(/https?:\/\/\S+/)?.[0] as string;
  const token = extractTokenFromEmail(message.text);

  await page.goto(link);
  await fillAndSubmit(page, { 新しいパスワード: newPassword }, "パスワードを再設定");
  await expect(page.getByText("パスワードを再設定しました")).toBeVisible();
  expect(page.url()).not.toContain(token);

  await page.goto("/login");
  await login(page, user);
  await expect(alertIn(page)).toContainText(LOGIN_FAILED);

  await login(page, { email: user.email, password: newPassword });
  await expect(page).toHaveURL(/\/today$/);
  await page.getByRole("button", { name: "ログアウト" }).click();

  await page.goto(link);
  await fillAndSubmit(page, { 新しいパスワード: `Again-${newPassword}` }, "パスワードを再設定");
  await expect(page.getByText("リンクが無効、または期限が切れています。")).toBeVisible();
});

test("password reset 要求は未登録の email でも同じ完了表示で、メールは送られない", async ({
  page,
}) => {
  const stranger = createFakeUser();

  await page.goto("/password-reset");
  await fillAndSubmit(page, { メールアドレス: stranger.email }, "案内を送る");

  await expect(page.getByText("再設定の案内を送信しました(登録がある場合)")).toBeVisible();
  await expect(
    waitForEmail({ to: stranger.email, timeoutMs: 1500, intervalMs: 250 }),
  ).rejects.toThrow(/届きませんでした/);
});

test("無効な token のメール確認は理由を区別せず、再送へ案内する", async ({ page }) => {
  await page.goto("/verify-email?token=bogus-token");
  await page.getByRole("button", { name: "メールアドレスを確認する" }).click();

  await expect(page.getByText("リンクが無効、または期限が切れています。")).toBeVisible();
  await expect(page.getByRole("link", { name: "確認メールを再送する" })).toBeVisible();
  expect(page.url()).not.toContain("bogus-token");
});

test("確認メールの再送は未登録の email でも同じ完了表示になる", async ({ page }) => {
  await page.goto("/verify-email");
  await fillAndSubmit(page, { メールアドレス: createFakeUser().email }, "確認メールを再送する");

  await expect(
    page.getByText("確認メールを送信しました(登録がある場合)", { exact: false }),
  ).toBeVisible();
});

test("入力エラーは request を送らず、要約へフォーカスし、項目に aria-invalid と説明を付ける", async ({
  page,
}) => {
  let signupRequests = 0;
  await page.route("**/api/v1/auth/signup", async (route) => {
    signupRequests += 1;
    await route.continue();
  });

  await page.goto("/signup");
  await page.getByRole("button", { name: "アカウントを作成" }).click();

  const summary = alertIn(page);
  await expect(summary).toBeFocused();
  await expect(summary).toContainText("メールアドレスを入力してください。");
  await expect(summary).toContainText("パスワードを入力してください。");

  const email = page.getByLabel("メールアドレス", { exact: true });
  await expect(email).toHaveAttribute("aria-invalid", "true");
  await expect(email).toHaveAccessibleDescription("メールアドレスを入力してください。");

  // 要約のリンクから該当の入力欄へ移動できる。
  await summary.getByRole("link", { name: "メールアドレスを入力してください。" }).click();
  await expect(email).toBeFocused();
  expect(signupRequests).toBe(0);
});

test("password policy 違反は固定文言で表示し、server の文言は出さない", async ({ page }) => {
  await page.goto("/signup");
  await fillAndSubmit(
    page,
    { メールアドレス: createFakeUser().email, パスワード: "short" },
    "アカウントを作成",
  );

  const summary = alertIn(page);
  await expect(summary).toContainText(
    "パスワードの条件を満たしていません。8文字以上128文字以内で入力してください。",
  );
});

test("二重クリックしても signup の request は 1 回だけ送られる", async ({ page }) => {
  let signupRequests = 0;
  await page.route("**/api/v1/auth/signup", async (route) => {
    signupRequests += 1;
    await new Promise((resolve) => setTimeout(resolve, 600));
    await route.continue();
  });
  const user = createFakeUser();

  await page.goto("/signup");
  await page.getByLabel("メールアドレス", { exact: true }).fill(user.email);
  await page.getByLabel("パスワード", { exact: true }).fill(user.password);
  const button = page.getByRole("button", { name: "アカウントを作成" });
  await button.dblclick();

  await expect(page.getByText("確認メールを送信しました。届いていない場合は")).toBeVisible();
  expect(signupRequests).toBe(1);
});

test("通信に失敗した login は固定の通信失敗文言で、入力した email は保持される", async ({
  page,
}) => {
  await page.route("**/api/auth/csrf", (route) => route.abort("connectionrefused"));
  const user = createFakeUser();

  await page.goto("/login");
  await login(page, user);

  await expect(alertIn(page)).toContainText("通信に失敗しました。");
  await expect(page.getByLabel("メールアドレス", { exact: true })).toHaveValue(user.email);
});

test("セキュリティヘッダーが付与される(clickjacking と token の Referer 漏えい対策)", async ({
  request,
}) => {
  const response = await request.get("/login");

  expect(response.headers()["x-frame-options"]).toBe("DENY");
  expect(response.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(response.headers()["referrer-policy"]).toBe("no-referrer");
});
