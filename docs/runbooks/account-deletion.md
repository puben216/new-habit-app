# アカウント削除の Runbook

対象: アカウント削除([account-deletion.md](../specs/account-deletion.md)、[ADR-006](../adr/ADR-006-legal-baseline.md))。

## 仕組み(要点)

- 利用者がパスワードを再入力して削除を要求すると、アカウントは `deletion_pending`(削除予約)になり、全 session が失効する。**30 日の猶予**のあいだは、再ログインして「削除を取り消す」で元に戻せる。
- 猶予を過ぎると、日次の削除ジョブ(`account-purge`)が `users` の行を削除する。子データは `ON DELETE CASCADE` で一緒に削除される。ジョブが未実行でも、猶予を過ぎた時点から取り消しはできなくなる。
- 削除予約中は、通知は送られず、管理者としても無効になる(`users.status` が `active` でないため)。

## 禁止事項

- 利用者のメールアドレス・パスワードを、チケット・チャット・ログに貼らない。調査は公開 ID(UUID)で行う。
- DB を直接更新して `status` や `deleted_at` を書き換えない(CHECK 制約があり、監査も残らない)。取り消しは利用者本人の操作、削除はジョブだけが行う。

## 削除ジョブの手動実行

前提: DB の接続情報を持つ環境で、`ACCOUNT_PURGE_ENABLED=true`、`DATABASE_URL`(または `DATABASE_URL_SECRET_ARN`)、`AWS_REGION` を設定する。

```text
pnpm account:purge
```

- 出力は件数だけ(`{"purged":N,"failed":N,"skipped":N}`)。Feature Flag が無効なら DB に接続せず終了コード 3 で終わる。
- 1 回の実行は最大 50 件(古い順)。残りがある場合は再度実行する。何度実行しても安全(冪等)。
- `failed` が出た場合は、そのユーザーは削除されず次回に再試行される(外部データの片付けの失敗など)。続く場合は、アプリのログ(件数のみ)と DB の接続を確認する。

## 問い合わせへの対応

### 「削除していないのにアカウントが使えない」

1. 本人確認のうえ、公開 ID を特定する(管理画面のユーザー検索)。管理画面の状態が「削除待ち」なら削除予約中。
2. 監査ログで要求の時刻と IP の不可逆化表現を確認する。

```sql
SELECT created_at, actor, action, request_id, ip_hash FROM audit_logs
WHERE target_public_id = '<公開 ID>' ORDER BY created_at;
```

3. 猶予期間内であれば、本人に再ログインして「削除を取り消す」を案内する。パスワードが分からない場合は、通常のパスワード再設定の後に再ログインする。
4. 猶予を過ぎている場合、取り消しはできない(ジョブ実行後は復元できない)。バックアップからの復元は、保持期間内であっても個別の判断と承認が必要。

### 誤って削除が実行された

猶予後のジョブ実行で削除されたデータは、DB からは復元できない。バックアップ基盤(T-502)の保持期間内であれば、承認のうえ復元を検討する。

## 確認用のクエリ

```sql
-- 削除予約中の件数と、最も古い要求
SELECT count(*), min(deleted_at) FROM users WHERE status = 'deletion_pending';

-- 猶予が終わっているのに残っているもの(ジョブが止まっていないかの確認)
SELECT count(*) FROM users
WHERE status = 'deletion_pending' AND deleted_at <= now() - interval '30 days';

-- 直近 7 日の削除の実行
SELECT created_at, target_public_id FROM audit_logs
WHERE action = 'system.account.purged' AND created_at >= now() - interval '7 days';
```

「猶予が終わっているのに残っている」が続く場合は、ジョブが動いていない(Feature Flag が無効、スケジュール未配置、失敗の繰り返し)。上の手動実行で件数を確認する。

## 配置(T-501 以降)

- 日次の EventBridge Scheduler から `account-purge` の Lambda を起動する(Terraform は T-501 で追加)。最初は `ACCOUNT_PURGE_ENABLED=false` で配置し、手動実行で動作を確認してから有効にする。
- 失敗件数の増加や、実行間隔の途切れに対するアラームは T-501 の observability 設計で扱う。

## 外部データ・バックアップ

- AI provider・メール provider 側に送ったデータの削除は、provider の確定後(ADR-003、T-305 完了〜T-505 前)に `ExternalDataCleanupPort` の実装として追加する。それまでは provider にデータを送っていない(AI は fake のみ)。
- バックアップに残るデータは、保持期間の経過で消える。保持期間は T-502 で決めて、プライバシーポリシーに明記する。
