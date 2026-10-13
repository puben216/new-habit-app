import { getPurge } from "./container";

/**
 * アカウント削除ジョブの手動実行(`pnpm account:purge`。docs/runbooks/account-deletion.md)。
 * Lambda と同じ composition root・handler を使う。`ACCOUNT_PURGE_ENABLED=true`、`DATABASE_URL`(または
 * `DATABASE_URL_SECRET_ARN`)、`AWS_REGION` が必要。標準出力には件数だけを出す(識別子・内容は出さない)。
 */
async function main(): Promise<number> {
  try {
    process.loadEnvFile(".env");
  } catch {
    // .env がなくても、環境変数が直接設定されていればよい。
  }
  const result = await (await getPurge())();
  console.log(JSON.stringify(result));
  return "disabled" in result ? 3 : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  () => {
    // 例外の詳細(接続文字列・SQL など)を出力しない。
    console.error("実行に失敗しました。設定と DB への接続を確認してください。");
    process.exitCode = 1;
  },
);
