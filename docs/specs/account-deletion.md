# アカウント削除 Spec

Status: Ready
責任者: TBD
最終更新: 2026-10-12
変更区分: Standard
ロードマップ項目: T-404(PR-A。エクスポートは PR-B で別の Spec を作成する)

## 目的

Member が、パスワードの再入力(再認証)を経て自分のアカウントの削除を要求し、30 日の猶予期間のあいだは再ログインして取り消せ、期限後に個人データが物理削除されるようにする(UC-18、PRD 機能要件 12)。猶予期間と取り消しの方針は [ADR-006](../adr/ADR-006-legal-baseline.md) に従う。削除要求中のアカウントは通常のデータ参照・更新・通知の対象から外し、取り消し以外の操作を受け付けない。

## 成功指標

- 再認証(パスワード)に成功しない限り、削除要求は受理されない。誤りの繰り返しは制限される(Integration Test)。
- 削除要求の直後に、そのユーザーの全 session が失効し、他の Member API・画面はどの session でも使えない(再ログインしても取り消し画面にしか入れない)(Unit/Integration/E2E)。
- 猶予期間内に再ログインして取り消すと、データを失わずに通常の状態へ戻る(Integration/E2E)。
- 期限後のジョブで、`users` の行と、そのユーザーに属するすべての個人データ(DB の全 FK 経路)が削除され、削除の事実が監査ログに残る(Integration)。新しいテーブルが `users` を参照するときに `ON DELETE CASCADE` を忘れると検知できる(Integration)。
- ジョブは重複実行・並行実行・途中失敗に対して安全で、取り消しと競合してもどちらか一方だけが成立する(Integration)。
- パスワード、メールアドレス、session token が、ログ・監査ログ・エラー応答に含まれない(Unit/Integration)。

## 範囲

- Domain: 猶予期間の定数と期限の計算、アカウント状態の型(`active|suspended|deletion_pending`)。
- Application: `requestAccountDeletionUseCase`(再認証、状態遷移、session 失効、監査)、`cancelAccountDeletionUseCase`、`getAccountDeletionStatusUseCase`、`purgeExpiredAccountsUseCase`(期限到来の削除。外部データの片付け用の port を呼ぶ)、各 port。
- Infrastructure: Prisma repository(条件付き更新、削除の transaction)、`login_attempts` を使う再認証の試行制限、外部データ片付け port の何もしない実装、`findSessionDetails` への `userStatus` の追加。
- DB: Migration 1 本(`users` の状態と `deleted_at` の整合 CHECK、期限スキャン用の部分 index、`login_attempts.purpose` に `reauth` を追加)。
- Presentation(`apps/web`): `DELETE /api/v1/me`、`GET /api/v1/me/deletion`、`POST /api/v1/me/deletion/cancel`、session の `accountStatus` を使う中央の actor 解決の変更。
- 画面: 削除の要求(`/account/delete`)、削除予約中の取り消し(`/account/restore`)、プロフィール画面からの導線、ログイン画面の案内。
- Worker: 期限到来のアカウントを削除する handler(`apps/workers`)とその composition root。
- 文書: `docs/04`、`docs/05`、`docs/08`、`docs/09`、`docs/10`、Runbook、Playwright E2E。

## 対象外

- データエクスポート(PR-B。着手時に別の Spec と Plan を作成する)。
- 削除ジョブを定期実行する Lambda・EventBridge の Terraform と実環境への配置(共通基盤 T-501/T-502 で追加。コードと手動実行可能な handler までを本タスクで用意する)。
- 削除要求・取り消しのメール通知(認証メールの SES 送信 T-405 以降。受容リスク参照)。
- AI provider・メール provider に送信済みのデータの削除。provider が未確定(ADR-003)のため、削除ジョブから呼ぶ差し込み口(port)だけ用意し、実装は provider 確定時(T-305 完了〜T-505 前)に行う。`docs/10` に未決として記録する。
- バックアップからの削除。保持期間の経過で消える方針とし、バックアップ基盤(T-502)で保持期間を決めてプライバシーポリシーに書く。
- 再認証での MFA(TOTP)の要求。パスワードのみで実装し、再認証の段階を後から増やせる構造にする。
- `suspended` の扱いの変更、Admin による削除の代行、削除の理由の収集、Rate limit の共通基盤(P2 未決)。

## アクターと前提条件

| アクター                 | 前提条件                                              | できること                                           |
| ------------------------ | ----------------------------------------------------- | ---------------------------------------------------- |
| Guest(未認証)            | なし                                                  | すべての `/me*` が `401`                             |
| Member(active)           | login 済み                                            | 削除の要求(再認証あり)、状態の確認                   |
| Member(deletion_pending) | 削除を要求済みで、期限前。再ログインで session を得る | 状態の確認、取り消し。それ以外の Member API は `401` |
| Worker(定期ジョブ)       | DB に到達できる                                       | 期限到来のアカウントの削除                           |

actor の user ID は session のみから取得し、request の body/query/path/header から受け取らない。

## 機能要件

### ACD-001 再認証

- `DELETE /api/v1/me` は body `{ password }` を受け取る。保存済みのパスワードハッシュに対して検証し(login と同じ `PasswordHasherPort`)、一致しなければ `403`(`code: reauthentication_failed`)。誤りの種類(不一致・形式)は区別しない。
- 失敗の記録と制限: 直近 15 分間に再認証の失敗が 5 回あるユーザーは、パスワードが正しくても検証せず `429`(`code: too_many_attempts`)を返す。成功した試行も記録する。制限は `login_attempts`(`purpose = 'reauth'`)を使い、通常のログインの制限とは独立にする。
- パスワードは request body からのみ受け取り、ログ・監査・エラー・URL に含めない。

### ACD-002 削除の要求

- 再認証に成功したら、1 つの transaction で次を行う: `users.status = 'deletion_pending'`、`users.deleted_at = now`(Clock)、そのユーザーの全 session の削除、監査ログの追記(`user.account.deletion_requested`)。
- 応答は `200`、body `{ status: "deletion_pending", scheduledFor }`(`scheduledFor` は `deleted_at` の 30 日後の ISO 日時)。
- 既に `deletion_pending` のアカウントは Member API に到達できない(ACD-003)ため、二重の要求は発生しない。並行する要求は、条件付き更新(`WHERE status = 'active'`)で 1 件だけが成立し、残りは `409`(`code: deletion_already_requested`)。

### ACD-003 削除予約中の扱い

- 削除予約中のユーザーも login できる(ADR-006: 再ログインでの取り消しのため)。session には `accountStatus` が載り、Member 向けの全 API の actor 解決(`actorUserIdFromSession`)は `deletion_pending` の session では `null` を返す(= `401`)。Admin 向けの判定も同様に通らない。
- Member 向けの画面(`(app)` 配下)は、削除予約中の session では `/account/restore` へ redirect する。認証画面(login/signup 等)の「認証済みなら保護画面へ」の判定も同様に `/account/restore` へ向ける。
- 通知: 削除予約中のユーザーには通知を送らない(受信者の解決で `status = 'active'` を要求する既存の挙動に従う。Integration Test で確認)。管理者としては無効(既存の `u.status = 'active'` 条件)。
- `deletion_pending` 中も DB のデータは削除しない(取り消しで復元できるようにするため)。

### ACD-004 取り消し

- `POST /api/v1/me/deletion/cancel`(body なし)は、削除予約中の session だけが使える。条件付き更新(`WHERE status = 'deletion_pending' AND deleted_at > now - 30 日`)で `status = 'active'`、`deleted_at = NULL` に戻し、監査ログ(`user.account.deletion_cancelled`)を追記して `200`、body `{ status: "active" }`。
- active のアカウントが呼んだ場合は `409`(`code: deletion_not_requested`)。猶予期間(30 日)を過ぎている場合は、削除ジョブが未実行でも取り消せず `409`(`code: grace_period_expired`)。
- 取り消し時に失効済みの session は復活しない(再ログインで得た session をそのまま使う)。

### ACD-005 状態の取得

- `GET /api/v1/me/deletion` は、active または deletion_pending の session が使え、`{ status: "active" | "deletion_pending", scheduledFor: string | null }` を返す(`scheduledFor` は削除予約中のみ)。

### ACD-006 期限到来の削除(ジョブ)

- `purgeExpiredAccountsUseCase` は、`status = 'deletion_pending' AND deleted_at <= now - 30 日` のユーザーを古い順に最大 50 件(定数)取得し、1 件ずつ独立した transaction で処理する。
- 1 件の処理: (1) 行をロックして条件を再確認(取り消し・並行ジョブとの競合を排除)、(2) 外部データの片付け port を呼ぶ(失敗したらそのユーザーは削除せず、次回に再試行)、(3) 監査ログに `system.account.purged`(対象はユーザーの公開 ID。actor は `system`)を追記、(4) `users` の行を削除(`ON DELETE CASCADE` が子データをすべて削除)。(3) と (4) は同一 transaction で、片方だけが成立しない。
- 結果は件数(削除済み、失敗、条件不一致でスキップ)のみを返し、ログにも件数だけを出す。ユーザーの識別子・メール・内容を出さない。
- 同じユーザーを再度処理しても何も起きない(冪等)。ジョブの重複起動・並行起動で二重に削除されたり、例外になったりしない。
- Feature Flag(環境変数)が無効の間は、DB に接続せず何もしない(Terraform 配置前に誤って走らないため)。

### ACD-007 画面

- `/account/delete`(ログイン済みの active な Member): 削除されるデータの説明、30 日の猶予と取り消し方法の説明、パスワード入力、「削除を要求する」ボタン(確認の 2 段階)。成功したら `/login?reason=deletion_requested` へ移り、案内文(「削除を受け付けました。30 日以内に再ログインすると取り消せます」)を表示する。失敗は固定文言(再認証失敗、制限中、通信失敗)。
- `/account/restore`(削除予約中の session のみ): 削除予定日時(UTC 固定書式)と、「削除を取り消す」ボタン、「ログアウト」。取り消しに成功したら `/today` へ。active の session や未認証は、それぞれ `/today`・`/login` へ redirect する。
- プロフィール画面に「アカウントを削除する」への導線を置く(目立たせすぎず、説明付き)。

## 業務ルールと不変条件

- ACD-INV-001(猶予期間): 30 日(ADR-006)。`ACCOUNT_DELETION_GRACE_DAYS` を Domain の 1 箇所のみで定義し、要求の応答・取り消しの可否・ジョブの対象判定がこの定数だけを参照する。期限は `deleted_at + 30 日`(UTC の経過日数。ローカル日付には依存しない)。
- ACD-INV-002(状態の整合): `status = 'deletion_pending'` と `deleted_at IS NOT NULL` は同値(DB の CHECK)。状態の変更は条件付き更新の単一文で行い、読み取り後の更新をしない。
- ACD-INV-003(参照の遮断): `deletion_pending` の session は、`actorUserIdFromSession` を通るすべての経路で actor を持たない。新しい Member API が自動的に遮断されるよう、判定をこの 1 箇所に集約する。例外(状態の取得と取り消し)だけが専用の取り出し関数を使う。
- ACD-INV-004(削除の完全性): `users` を参照するすべての外部キーは `ON DELETE CASCADE`(Integration Test が `information_schema` から全 FK を列挙して検証する)。FK を持たない個人データ(`audit_logs` の actor・target は公開 ID のみで、メールや内容を含まない)は削除対象にせず、ID 以外の情報を持たないことをテストで確認する。
- ACD-INV-005(パスワードの非露出): パスワードはハッシュ検証にのみ使い、保存・ログ・監査・エラー応答・URL に出さない。
- ACD-INV-006(監査): 要求・取り消し・削除を `audit_logs` に追記する。記録するのは actor(`user:{公開 ID}` または `system`)、action、対象の種別と公開 ID、request ID、IP の不可逆化表現のみ。削除したユーザーの監査行は匿名の公開 ID だけを残し、他の列で個人を特定できない。
- ACD-INV-007(冪等と競合): 取り消しと削除は同じ行のロック・条件付き更新で直列化され、どちらか一方だけが成立する。

## 状態遷移

| 現在             | 操作                   | 次               | 拒否される条件                                   |
| ---------------- | ---------------------- | ---------------- | ------------------------------------------------ |
| active           | 削除の要求(再認証あり) | deletion_pending | 再認証失敗(403)、制限中(429)、並行要求(409)      |
| deletion_pending | 取り消し(再ログイン後) | active           | 猶予期間の経過後(409 grace_period_expired)       |
| deletion_pending | 削除ジョブ(期限到来)   | (行が削除される) | 期限前、取り消し済み、片付けの失敗(次回に再試行) |
| deletion_pending | 他の Member 操作       | (変化なし)       | すべて 401                                       |
| active           | 取り消し               | (変化なし)       | 409 deletion_not_requested                       |

## 受け入れ基準

```gherkin
Scenario: 再認証に成功して削除を要求する
  Given active な Member が login している
  When 正しいパスワードで DELETE /me を送る
  Then 200 で status=deletion_pending と scheduledFor(要求の 30 日後)が返る
  And users.status=deletion_pending、deleted_at が設定され、そのユーザーの session が 0 件になる
  And audit_logs に user.account.deletion_requested が 1 件追加され、パスワードやメールは含まれない

Scenario: パスワードが誤りなら受理されない
  When 誤ったパスワードで DELETE /me を送る
  Then 403 reauthentication_failed で、状態は active のまま、session も残る
  And 5 回連続で失敗した後は、正しいパスワードでも 429 too_many_attempts になる
  And 通常のログインはこの失敗の影響を受けない

Scenario: 削除予約中は取り消し以外できない
  Given 削除を要求済みのユーザーが再ログインする
  When /api/v1/habits、/api/v1/me、/api/v1/daily-check-ins/{date} などを呼ぶ
  Then すべて 401 になる
  And /today を開くと /account/restore へ移る
  And GET /me/deletion は 200 で status=deletion_pending と scheduledFor を返す

Scenario: 猶予期間内の取り消し
  Given 削除予約中のユーザーが再ログインしている
  When POST /me/deletion/cancel を呼ぶ
  Then 200 で status=active になり、deleted_at は NULL に戻る
  And 習慣・記録などのデータはそのまま残り、再び Member API が使える
  And audit_logs に user.account.deletion_cancelled が追加される

Scenario: 猶予期間を過ぎると取り消せない
  Given 削除予約から 30 日以上経過し、ジョブが未実行
  When 取り消しを呼ぶ
  Then 409 grace_period_expired

Scenario: 期限後のジョブで完全に削除される
  Given 削除予約から 30 日経過したユーザーと、習慣・記録・チェックイン・週次レビュー・通知設定・配送・AI ジョブ・suppression を持つ
  When 削除ジョブが実行される
  Then users の行と、それらの全データが削除される
  And audit_logs に system.account.purged(対象の公開 ID のみ)が追加される
  And 期限前のユーザーと、取り消し済みのユーザーは削除されない

Scenario: ジョブの安全性
  When 同じ対象に対して削除ジョブを 2 件並行して実行する
  Then 削除は 1 回だけ成立し、どちらも例外にならず、監査行は 1 件
  And 外部データの片付けが失敗したユーザーは削除されず、次回の実行で再試行される

Scenario: 取り消しとジョブの競合
  When 期限の直前に取り消しと削除ジョブを同時に実行する
  Then どちらか一方だけが成立する(取り消しが勝てばデータは残り、ジョブが勝てば取り消しは失敗する)

Scenario: 削除予約中は通知されず、管理者でもない
  Given 通知を有効にしていたユーザーが削除を要求した
  Then リマインドは送信されない
  And そのユーザーが Admin だった場合、管理 API は 404 になる

Scenario: 画面
  When Member が /account/delete からパスワードを入力して削除を要求する
  Then /login に案内が表示され、再ログインすると /account/restore に着き、取り消すと /today に戻れる
```

## 認可マトリクス

| 操作                     | Guest | Member(active) | Member(deletion_pending) | 備考                                  |
| ------------------------ | ----: | -------------: | -----------------------: | ------------------------------------- |
| DELETE /me               |   401 |    Yes(再認証) |                      401 | 自分のアカウントのみ                  |
| GET /me/deletion         |   401 |            Yes |                      Yes | 自分のみ                              |
| POST /me/deletion/cancel |   401 |            409 |                      Yes | 自分のみ                              |
| その他の Member API      |   401 |            Yes |                      401 | `actorUserIdFromSession` で一括遮断   |
| 削除ジョブ               |     — |              — |                        — | Worker(DB 権限)のみ。Web/API から不可 |

path・body にユーザーを含めないため IDOR の経路がない。

## APIとイベント

共通: base path `/api/v1`、JSON、未知キー拒否、Problem Details、`Cache-Control: no-store`。状態を変える操作は Origin 検証(`403 invalid_origin`)、`Content-Type: application/json`(`415`。`DELETE /me` のみ。body 上限 1 KiB、`413`)。Events は発行しない。契約の正本は `packages/contracts/src/account-deletion.ts` の runtime schema と本 Spec(OpenAPI 生成基盤は未導入)。

| Method/Path                | 入力           | 成功 | エラー                                                                          |
| -------------------------- | -------------- | ---- | ------------------------------------------------------------------------------- |
| `DELETE /me`               | body: password | 200  | 401, 403(reauthentication_failed, invalid_origin), 404, 409, 413, 415, 422, 429 |
| `GET /me/deletion`         | なし           | 200  | 401, 404                                                                        |
| `POST /me/deletion/cancel` | なし           | 200  | 401, 403, 404, 409(deletion_not_requested, grace_period_expired)                |

- 409 の `code` は、`deletion_already_requested`(`DELETE`)、`account_not_active`(`DELETE`。停止中など active でないアカウント)、`deletion_not_requested`・`grace_period_expired`(取り消し)。
- 404 は `user_not_found`(session の user が存在しない)。422 は `validation_failed`(password が文字列でない、空、長さ上限 128 超)。
- `DELETE /me` は既存の `/me` の `GET`/`PATCH` と同じ path で、認証・Origin の共通処理を使う。

## データとMigration

Migration `t404_account_deletion`(expand のみ):

- `CHECK ((status = 'deletion_pending') = (deleted_at IS NOT NULL))` を `users` に追加(ACD-INV-002)。既存の行は `deleted_at` を書くコードがなく `deletion_pending` もないため、違反しない前提。違反する環境では Migration が止まるだけでデータは変更されない。
- 期限スキャン用: `CREATE INDEX users_deletion_pending_deleted_at_idx ON users (deleted_at) WHERE status = 'deletion_pending'`(アクセスパターン `WHERE status = 'deletion_pending' AND deleted_at <= ? ORDER BY deleted_at`)。
- `login_attempts_purpose_check` を `('signup','login','verify_resend','password_reset','reauth')` に置き換える(値の追加のみで後方互換)。
- 他のテーブルの FK は変更しない(すべて既に `ON DELETE CASCADE`)。FK `user_id` の index の要否は既存の確認結果から変更なし。
- rollback: アプリの revert。必要なら CHECK・index・制約値を戻す forward Migration を追加する(適用済み Migration は編集しない)。fresh と upgrade の両方を Integration Test で検証する。

## 失敗・境界ケース

- 空のパスワード・文字列以外・128 文字超 → 422 `validation_failed`(再認証の失敗として数えない)。
- 停止中(`suspended`)のアカウントが削除を要求した場合は `409 account_not_active`(停止の解除を、削除で回避できないようにする)。
- 削除ジョブの途中失敗(片付け port の例外、DB 障害): 該当ユーザーは `deletion_pending` のまま残り、次回に再試行。他のユーザーの処理は継続する。
- 削除ジョブが長期間動かなかった場合: 期限が過ぎても取り消しは拒否され(`grace_period_expired`)、復旧後のジョブで削除される。
- 削除予約中に password reset を行った場合: 再ログイン後に取り消せる(既存の挙動)。
- 削除予約中のユーザーと同じメールでの新規登録: メールは `users` に残っているため `already_exists` として扱われる(列挙防止の既存挙動)。期限後の削除でメールが解放される。
- session の user が削除済み(ジョブが先に成立)→ `404 user_not_found` または `401`。
- DB 制約違反(アプリをすり抜けた場合)→ 内部エラー(500)。内部詳細は応答に含めない。

## セキュリティとプライバシー

- 収集・保持データ: 削除要求の時刻(`deleted_at`)、監査行(匿名の公開 ID、時刻、action)。メール・パスワードを新たに保持しない。削除後に残るのは、公開 ID だけの監査行と、バックアップ(保持期間は T-502 で決定)。
- 外部送信: なし。provider 側のデータは対象外(port の差し込み口のみ。`docs/10` に未決として記録)。
- ログ禁止データ: パスワード、メール、session token、request body。ジョブのログは件数のみ。
- 脅威と対策:
  - session 乗っ取りによる削除: 再認証(パスワード)を必須にし、失敗は制限する。猶予 30 日と取り消しで被害を限定する。メール通知は未対応(受容リスク)。
  - 総当たり(再認証): 5 回/15 分で `429`。制限中は検証しない。
  - IDOR: path・body にユーザーを持たない。
  - CSRF: Origin 検証 + `application/json`。XSS: JSON のみ。UI は固定文言を React で描画する。
  - 権限昇格・列挙: 削除予約中の遮断を 1 箇所に集約。誤りの種類は区別しない。
  - 削除ジョブの悪用: Web/API から呼べない。行ロックと条件の再確認で、取り消された対象を消さない。
- 個人情報の削除: 参照するすべての FK が CASCADE であることをテストで保証する。

## AI要件

N/A。AI を利用しない。AI provider 側のデータの扱いは対象外(上記)。

## 可観測性と運用

- ログ: ジョブは件数(削除済み/失敗/スキップ)のみ。個人情報を出さない。route に独自ログを追加しない。
- Metrics/Alerts: 削除ジョブの失敗件数・実行間隔の異常は T-501 の observability 設計で扱う。Runbook に確認手順(監査ログのクエリ、手動実行、失敗時の対応)を書く。
- Runbook: [account-deletion.md](../runbooks/account-deletion.md) を新規に作成する(要求の調査、誤削除の問い合わせ、ジョブの手動実行、バックアップの扱い)。
- 展開/ロールバック: ジョブは Feature Flag で無効のまま配置し、確認後に有効にする。Web/API はフラグなし(削除予約は取り消し可能で、ジョブが無効の間は何も削除されない)。revert でコードを戻せる。

## テスト対応表

| 要件        | Unit                                                                                   | Integration(実 PostgreSQL)                                                   | E2E                                   |
| ----------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------- |
| ACD-001     | 再認証の成否・制限・順序(制限中は検証しない)、パスワードが結果・エラーに現れない       | `login_attempts` の reauth 記録と制限(login と独立)                          | 誤パスワード、制限                    |
| ACD-002     | 要求の use case(fake: 状態・session・監査)、handler の 200/401/403/409/413/415/422/429 | 単一 transaction(状態・session 削除・監査)、並行要求で 1 件のみ              | 要求から login への案内               |
| ACD-003     | `actorUserIdFromSession` の遮断(性質テスト)、guard の振り分け                          | `findSessionDetails` の userStatus、通知が送られない、管理 API が 404        | 予約中の画面遷移・API の 401          |
| ACD-004     | 取り消し(active/期限内/期限後/active への呼び出し)                                     | 条件付き更新、取り消し後にデータが残る                                       | 取り消して `/today` へ                |
| ACD-005     | handler                                                                                | -                                                                            | 復元画面の表示                        |
| ACD-006     | purge の振り分け(期限境界、件数上限、片付け失敗の継続、冪等)                           | 全データの削除、FK 経路の網羅、並行 2 件で 1 回、取り消しとの競合、監査 1 件 | (手動実行 handler の結果を DB で確認) |
| ACD-INV-001 | 期限計算の性質テスト(任意の時刻・境界)                                                 | -                                                                            | N/A                                   |
| ACD-INV-002 | -                                                                                      | CHECK(status と deleted_at の同値)、fresh と upgrade の Migration            | N/A                                   |
| ACD-INV-004 | -                                                                                      | 全 FK が CASCADE であることを `information_schema` で検証                    | N/A                                   |
| ACD-007     | 画面の固定文言・`next` 無関係の遷移                                                    | -                                                                            | 画面を通した要求・取り消し            |

テスト品質の 3 観点: (1) プロパティベース(期限計算、`actorUserIdFromSession` の遮断、purge の対象判定)、(2) 変異テスト(Stryker 未導入。期限の境界・状態の条件・遮断・ロック順序を手動で壊して検知を確認)、(3) 敵対的審査(取り消しとの競合、二重要求、総当たり、削除漏れ、予約中のアクセス経路を攻撃者の視点で見直して結果を報告)。Fake/Stub 方針: Application の unit は in-memory fake と固定 Clock、外部データ片付けは fake。Integration は Testcontainers。fixture は架空データのみ。

## 未決事項

実装をブロックしない事項:

- **AI provider・メール provider のデータ削除**: provider 確定時(ADR-003、T-305 完了〜T-505 前)に、`ExternalDataCleanupPort` の実装と手順を決める。`docs/10` に記録する。
- **バックアップからの削除**: T-502 で保持期間を決めてプライバシーポリシーに明記する。
- **削除・取り消しのメール通知**: T-405(認証メールの SES 送信)以降に、取引メールの枠組みで検討する。
- **再認証の MFA**: 管理者以外への MFA 導入時に、再認証の段階を追加する。
- **猶予期間 30 日**: ADR-006 で決定済み。変更時は定数のみ更新する。

## 実装準備状況

Status: Ready
Reviewed at: 2026-10-12
Reviewed by: —

| Gate                 | Result | Evidence                                                                                         |
| -------------------- | ------ | ------------------------------------------------------------------------------------------------ |
| Product              | Pass   | 目的、成功指標、範囲/対象外。`docs/02` UC-18、`docs/09` T-404、ADR-006                           |
| Specification        | Pass   | ACD-001〜007、ACD-INV-001〜007、状態遷移、受け入れ基準。未決事項は非ブロック                     |
| Domain and Time      | Pass   | 期限は UTC の経過日数(ACD-INV-001)。Clock 注入。冪等・競合は条件付き更新と行ロック(ACD-INV-007)  |
| API and Data         | Pass   | APIとイベント、データとMigration(expand のみ、index、CHECK、fresh/upgrade 検証、rollback)        |
| Security and Privacy | Pass   | セキュリティとプライバシー、認可マトリクス(再認証、総当たり、IDOR、CSRF、予約中の遮断、ログ禁止) |
| AI                   | N/A    | AI を利用しない。provider 側データは対象外として未決事項に記録                                   |
| Testing              | Pass   | テスト対応表(Unit/Integration/E2E、3 観点)                                                       |
| Operations           | Pass   | 可観測性と運用(ログは件数のみ、Runbook、Feature Flag で無効のまま配置、rollback)                 |
| Planning             | Pass   | [../plans/account-deletion.md](../plans/account-deletion.md)                                     |

### 受容リスク

- 削除要求・取り消しのメール通知がない。乗っ取られた session でパスワードも知られている場合に、本人が気づくのは再ログイン時になる(猶予 30 日と取り消しで限定)。
- 再認証はパスワードのみ(MFA は将来)。
- 削除ジョブの定期実行(Terraform)は T-501 まで未配置。それまでは手動実行または未実行で、削除予約中のデータは猶予後も残る(取り消しは `grace_period_expired` で拒否される)。
- Rate limit は再認証のみ(`login_attempts`)。他の API の共通 rate limit は P2 未決のまま。
- AI・メール provider 側とバックアップのデータは本タスクでは削除されない。

### 未決事項

なし(上記は非ブロック)
