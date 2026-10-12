# 管理者の運用 Runbook

対象: 最小管理機能([minimal-admin.md](../specs/minimal-admin.md)、[ADR-012](../adr/ADR-012-admin-access.md))。

## 禁止事項(必ず守る)

- TOTP の登録 URI・リカバリーコード・暗号鍵(`ADMIN_TOTP_ENCRYPTION_KEY`)・HMAC 鍵(`AUDIT_IP_HASH_KEY`)をチャット・チケット・ログ・スクリーンショットに貼らない。
- 管理画面で得た情報(マスクされた email、公開 ID、状態)を、業務目的の範囲を超えて共有・保存しない。ユーザーの email 全体が必要な調査は、権限のある担当者が別の承認手順で行う。
- スクリプトを実行した端末の履歴(シェルの history、ターミナルのスクロールバック)に残った出力は、表示後すぐに削除する。

## 管理者を追加する(`admin:grant`)

前提: 対象者が通常どおり登録し、email 確認を終えている。実行する担当者が DB の接続情報と `ADMIN_TOTP_ENCRYPTION_KEY` を持っている(本番は承認された環境でのみ)。

1. リポジトリのルートで、必要な環境変数を設定して実行する: `pnpm admin:grant --email <対象者の email>`
2. 標準出力に表示される **otpauth URI** を、本人が認証アプリ(TOTP 対応のもの)に登録する(QR コード化して読み取る、または URI の `secret` を手入力)。**リカバリーコード 8 個** を本人が安全な場所に保管する。表示は一度だけで、再表示できない。
3. 本人が通常ログイン後、`/admin` を開くと `/admin/mfa` に移るので、認証アプリの 6 桁のコード(またはリカバリーコード)を入力して管理画面に入れることを確認する(API は `POST /api/v1/admin/mfa/verify`)。検証は session 単位で 30 分有効で、期限が切れると次の画面表示で再び確認コードの入力に移る。
4. 実行したことは監査ログ(`operator.admin.granted`)に残る。端末の出力を消去する。

「すでに有効な管理者」と表示された場合は何も変更されていない。MFA を作り直す場合は `admin:reset-mfa`。

## 管理者を無効にする(`admin:disable`)

退職・異動・端末紛失の疑いなどのとき、**直ちに** 実行する: `pnpm admin:disable --email <email>`

- 次のリクエストから、その人は管理 API で `404` になる。全 session の MFA 検証も失効する。
- 再び管理者にする場合は `admin:grant`(MFA が作り直される)。
- 監査ログ(`operator.admin.disabled`)に残る。

## MFA を作り直す(`admin:reset-mfa`)

認証アプリの端末を失った、リカバリーコードを使い切った、秘密の漏えいが疑われるとき: `pnpm admin:reset-mfa --email <email>`

- TOTP の秘密とリカバリーコードが作り直され、全 session の MFA 検証が失効する。新しい URI とコードは本人に安全に渡す。
- 本人確認(別経路での確認)をしてから実施する。監査ログ(`operator.admin.mfa_reset`)に残る。

## ロックされた場合

連続 5 回の失敗で 15 分ロックされる(`429`、`mfa_locked`)。待てば自動的に解除される。急ぐ場合は、本人確認のうえ `admin:reset-mfa`(ロックと失敗回数も解除される)。ロックが頻発する場合は、総当たりの試行を疑い、監査ログの `admin.mfa.failed`/`admin.mfa.locked` を確認する。

## 監査ログのレビュー

定期的(少なくとも週 1 回)と、不審な兆候があったときにレビューする。`audit_logs` は追記専用で、`actor` は `admin:<公開 ID>` または `operator`。

```sql
-- 直近 7 日の管理者ごとの操作件数
SELECT actor, action, count(*) FROM audit_logs
WHERE created_at >= now() - interval '7 days' AND actor LIKE 'admin:%'
GROUP BY actor, action ORDER BY actor, count(*) DESC;

-- MFA の失敗・ロックの推移
SELECT date_trunc('hour', created_at) AS hour, action, count(*) FROM audit_logs
WHERE action IN ('admin.mfa.failed', 'admin.mfa.locked') AND created_at >= now() - interval '7 days'
GROUP BY 1, 2 ORDER BY 1;

-- 特定のユーザー(公開 ID)がいつ誰に閲覧されたか
SELECT created_at, actor, action FROM audit_logs
WHERE target_public_id = '<ユーザーの公開 ID>' ORDER BY created_at DESC;
```

確認する観点: (1) 業務上の理由のない大量の `admin.user.search`/`admin.user.view`、(2) 深夜・休日の閲覧、(3) 無効化済みの管理者の MFA 試行(`admin.mfa.failed` は管理者でなければ記録されないので、`404` の連続は Web サーバーのログで確認)、(4) 想定外の `operator.*`。検索した email は監査に残らないため、調査が必要な場合は管理者本人と目的を確認する。

不審な点があれば、該当の管理者を `admin:disable` し、インシデント対応(docs/08)に従って報告する。

## 鍵の管理とローテーション

- `ADMIN_TOTP_ENCRYPTION_KEY`(32 バイトの鍵の base64): TOTP の秘密の暗号鍵。変更すると保存済みの秘密が復号できなくなるため、**すべての管理者に対して `admin:reset-mfa` が必要**(複数鍵の同時許容は未実装)。漏えいが疑われる場合のみ実施し、実施前に管理者全員へ周知する。
- `AUDIT_IP_HASH_KEY`: 監査ログの IP の HMAC 鍵。変更すると、過去の記録とのハッシュの突き合わせができなくなるだけで、機能には影響しない。
- どちらも値は Terraform の state・チャット・ログに残さない。Secrets Manager の器から ECS に渡す(共通基盤 T-501)。

## 障害時

- 管理 API が `500` を返す: 暗号鍵・HMAC 鍵が未設定、または DB 障害。監査の追記が失敗した場合は閲覧しない設計(fail closed)のため、DB の復旧後に自動的に回復する。
- ユーザー調査を止められない緊急時でも、監査を迂回する手順は用意しない(DB に直接接続する場合は、別途承認と記録を残す)。
