# データエクスポート Spec

Status: Ready
責任者: TBD
最終更新: 2026-10-13
変更区分: Standard
ロードマップ項目: T-404(PR-B。アカウント削除は PR-A の [account-deletion.md](account-deletion.md))

## 目的

Member が、パスワードの再入力(再認証)を経て、自分のデータ(プロフィール、習慣、記録、チェックイン、週次レビュー、通知設定、AI の結果)を JSON または CSV で取り出せるようにする(UC-17、PRD 機能要件 12)。ファイルの生成は非同期のジョブで行い、完成したものを短い期限内に本人だけがダウンロードできる。パスワード、session、トークン、MFA の秘密、監査ログなど、認証・運用に関わる情報は含めない。

## 成功指標

- 再認証(パスワード)に成功しない限り、エクスポートは作成されない。誤りの繰り返しは制限される(Integration Test)。
- 他のユーザーのエクスポートは、状態の確認もダウンロードもできず、存在の有無も推測できない(`404`。Integration/E2E)。
- 出力に、許可リストの項目以外(パスワードのハッシュ、session token、MFA の秘密、リカバリーコード、監査ログ、内部 ID)が含まれない(Unit/Integration Test)。
- ジョブは重複配送・並行実行・途中失敗に対して安全で、1 件のエクスポートが 1 回だけ確定する(Integration Test)。
- 期限(完成から 24 時間)を過ぎたファイルは、ダウンロードできず、定期ジョブで DB から削除される(Integration/E2E)。
- JSON はそのまま読め、CSV は Excel で文字化けせず開け、数式として実行される値(`=`、`+`、`-`、`@` で始まるセル)が無害化される(Unit/E2E)。
- 生成中に他の操作でデータが変わっても、エクスポートは一貫したスナップショットになる(Integration Test)。

## 範囲

- Domain(export): エクスポートの形式・状態・期限の定数と判定、出力データの型(許可リスト)、CSV の組み立て(エスケープ、数式の無害化)、保存のみ(無圧縮)の ZIP の組み立て。
- Application: `requestDataExportUseCase`(再認証、制限、ジョブの作成と投入、監査)、`listDataExportsUseCase`、`downloadDataExportUseCase`(所有者確認、期限、監査)、`processDataExportUseCase`(worker の本体。claim → 収集 → 生成 → 確定)、`cleanupExpiredDataExportsUseCase`、各 port、queue message の batch 処理。
- Infrastructure: `PrismaDataExportRepository`(ジョブの作成・claim・確定・解放、成果物の保存と読み出し、期限切れの削除)、`PrismaExportDataSource`(一貫したスナップショットでの収集)、inline の queue(ローカル/E2E 用)。
- DB: Migration 1 本(`data_exports`、`data_export_artifacts`)。
- Contracts: queue message、API の request/response。
- Presentation(`apps/web`): `POST/GET /api/v1/me/exports`、`GET /api/v1/me/exports/{id}/download`。画面 `/account/export`、プロフィール画面からの導線、ダウンロード。
- Worker(`apps/workers`): ジョブの処理と期限切れ削除の handler(Feature Flag `DATA_EXPORT_ENABLED`)。
- Config: `EXPORT_QUEUE_DRIVER`(`inline`/`sqs`。本番で `inline` を拒否)。
- 文書: `docs/04`、`docs/05`、`docs/08`、`docs/09`、`docs/10`、Runbook、Playwright E2E。

## 対象外

- 実 SQS の adapter、Lambda・EventBridge の Terraform、S3 への保存と署名付き URL(共通基盤 T-501/T-502)。それまでは成果物を DB に置く(`ExportArtifact` の保存先は repository の内側に閉じ、後で差し替えられる)。
- 削除予約中のユーザーのエクスポート(削除予約中は Member API を使えない。必要なら先に削除を取り消す)。
- 差分エクスポート、定期的な自動エクスポート、メールでの送付、他サービスへの移行形式、エクスポートの共有。
- notification の配送履歴、suppression、`idempotency_keys`、`login_attempts`、セッション、監査ログ、管理者のデータ(認証・運用の情報)。
- 大容量(上限を超えるデータ)の分割ダウンロード。
- Rate limit の共通基盤(P2 未決)。このタスクでは、エクスポートの作成頻度の上限と再認証の制限のみ。

## アクターと前提条件

| アクター           | 前提条件                                           | できること                                                       |
| ------------------ | -------------------------------------------------- | ---------------------------------------------------------------- |
| Guest(未認証)      | なし                                               | すべての `/me/exports*` が `401`                                 |
| Member(active)     | login 済み                                         | 作成(再認証あり)、一覧・状態の確認、自分のファイルのダウンロード |
| Member(削除予約中) | -                                                  | 使えない(`401`。Member API の一括遮断)                           |
| Worker             | job ID だけを入力に持つ。DB から所有者を再構築する | ジョブの処理、期限切れの成果物の削除                             |

actor の user ID は session のみから取得し、request の body/query/path/header から受け取らない。

## 出力するデータ(許可リスト)

「自分のデータ」のうち、本人が入力・生成したものだけを、次の項目に限って出力する。DB の行をそのまま出さず、項目を列挙して取り出す。公開 ID(UUID)は他のデータとの対応づけに使い、内部 ID(bigint)は出力しない。

| データ                 | 出力する項目                                                                                                                                   |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| アカウント             | `email`(確認済みの正規化済みアドレス)、`createdAt`                                                                                             |
| プロフィール           | `displayName`、`timezone`、`locale`、`weekStartsOn`                                                                                            |
| 習慣                   | `id`(公開 ID)、`kind`、`name`、`purpose`、`cue`、`minimumAction`、`replacementAction`、`status`、`createdAt`、`updatedAt`                      |
| 習慣のスケジュール     | `habitId`、`effectiveFrom`、`effectiveTo`、`daysOfWeek`、`targetCount`                                                                         |
| 習慣の記録             | `id`(公開 ID)、`habitId`、`date`、`status`、`quantity`、`note`、`source`、`createdAt`、`updatedAt`                                             |
| デイリーチェックイン   | `date`、`mood`、`difficulty`、`note`、`createdAt`、`updatedAt`                                                                                 |
| 週次レビュー           | `id`(公開 ID)、`weekStart`、`timezoneSnapshot`、`summary`、`reflection`、`status`、`completedAt`、`createdAt`                                  |
| 通知設定(ユーザー単位) | `enabled`、`localTime`、`timezone`、`quietHours`                                                                                               |
| AI の結果              | `id`(公開 ID)、`kind`、`status`、`promptVersion`、`outputSchemaVersion`、`provider`、`model`、`result`(構造化出力)、`failureCode`、`createdAt` |

含めないもの: パスワードのハッシュ、session、確認・再設定のトークン、MFA の秘密とリカバリーコード、監査ログ、通知の配送履歴・suppression、`idempotency_keys`、`login_attempts`、AI の入力の指紋、他ユーザーの情報。

## 機能要件

### EXP-001 エクスポートの作成(再認証)

- `POST /api/v1/me/exports` は body `{ password, format }`(`format` は `json` または `csv`)を受け取る。保存済みのパスワードハッシュに対して検証し(アカウント削除と同じ再認証。`login_attempts` の `reauth`)、一致しなければ `403`(`code: reauthentication_failed`)。直近 15 分に失敗が 5 回あるユーザーは、検証せず `429`(`too_many_attempts`)。
- 成功したら `data_exports` を `queued` で作成し、queue に `{ version: 1, exportId }` を投入して `202` と作成したエクスポート(EXP-003)を返す。投入に失敗した場合は、作成した行を `failed`(`enqueue_failed`)にして `503` を返す(行を残して原因を追える)。
- 同じユーザーに `queued`/`running` のエクスポートが既にあれば、新規作成せず `409`(`code: export_in_progress`)。ただし **60 分以上更新のない** `queued`/`running` は停止したとみなし(投入前のプロセス停止や message の消失で残った行)、`failed(worker_error)` にしてから判定する(永久に作成できなくなることを防ぐ)。作成頻度は直近 24 時間に 5 件まで(失敗・期限切れを含めて数える)。超えると `429`(`code: export_rate_limited`)。完成済み(`ready`)の古いエクスポートは、新しいものを作ると期限を待たずに無効になる(成果物を削除し、`expired` にする)。
- 作成と監査(`user.export.requested`)は同一 transaction。パスワードは検証にのみ使い、保存・ログ・監査・エラーに出さない。

### EXP-002 ジョブの処理(worker)

- `processDataExportUseCase` は job ID だけを受け取り、所有者を DB から再構築する(message に個人情報を載せない)。1 件の処理: (1) 単一文で claim(`queued`、または lease を過ぎた `running` だけが `running` になれる)、(2) 一貫したスナップショットでデータを収集(EXP-005)、(3) 形式に応じて生成(EXP-006)、(4) 上限(20 MiB)を超えたら `failed`(`too_large`)、(5) 成果物の保存と `ready` への確定を同一 transaction で行う。確定時に `expires_at = 完成時刻 + 24 時間`、`byte_size`、`completed_at` を記録する。
- at-least-once: 同じ message が重複配送されても、確定は 1 回だけ(終端状態の job は何もしない。lease 内の `running` は再配送に任せる)。一時的な失敗は `queued` に戻して再配送し(受信回数の上限は T-303 の `AI_JOB_MAX_RECEIVE` と同じ値の定数)、上限に達したら `failed`(`worker_error`)。
- 生成の例外・データの不整合など、再試行しても直らない失敗は `failed`(`generation_failed`)。失敗の理由はコードのみを保存し、データの内容・例外メッセージを残さない。

### EXP-003 一覧と状態の取得

- `GET /api/v1/me/exports` は、自分の直近 5 件(新しい順)を返す。各項目は `{ id, status, format, requestedAt, expiresAt, byteSize, failureCode }`(`id` は公開 ID)。`expiresAt`・`byteSize` は完成したもの(`ready`、および期限切れで表示上 `expired` になったもの)のみ、`failureCode` は `failed` のみ、他は `null`。
- 期限を過ぎた `ready` は、定期ジョブが `expired` にするまでの間も、表示上は `expired` として返す(時刻で判定する)。

### EXP-004 ダウンロード

- `GET /api/v1/me/exports/{id}/download` は、自分の `ready` かつ期限内のエクスポートだけを返す。他人の ID・存在しない ID・UUID でない ID は `404`(`export_not_found`。区別しない)。自分のものでも `ready` でなければ `409`(`export_not_ready`)、期限切れは `410`(`export_expired`)。
- 応答はファイル本体。`Content-Type`(JSON: `application/json; charset=utf-8`、CSV: `application/zip`)、`Content-Disposition: attachment; filename="habit-app-export-YYYYMMDD.json|.zip"`(日付は完成日の UTC。ファイル名にユーザー入力を含めない)、`Cache-Control: no-store`、`X-Content-Type-Options: nosniff`。
- ダウンロードのたびに監査(`user.export.downloaded`)を追記する。監査の追記に失敗したらファイルを返さない(fail closed)。

### EXP-005 収集(スナップショット)

- 収集は 1 つの `REPEATABLE READ` の読み取り transaction で行い、全データが同一時点の状態になる。`user_id = job の所有者` を全 query に含める。出力する項目は許可リストで列挙して SELECT し、`SELECT *` を使わない。
- 収集対象の `status` は全件(アーカイブ済みの習慣、下書きのレビューを含む)。件数が多い場合に備え、記録・チェックインは ID 順の keyset で分割して読み込む(1 回 5000 件)。

### EXP-006 生成(JSON / CSV)

- JSON: 1 つのファイル。トップレベルは `{ schemaVersion: 1, exportedAt, account, profile, habits: [{..., scheduleVersions: [...]}], habitEntries, dailyCheckIns, weeklyReviews, notificationSettings, aiResults }`。日時は ISO 8601(UTC)、日付は `YYYY-MM-DD`、未設定は `null`。項目名は英語のキャメルケース(契約として固定し、変更時は `schemaVersion` を上げる)。
- CSV: 1 つの ZIP に、データ種別ごとの CSV(`account.csv`、`profile.csv`、`habits.csv`、`habit_schedule_versions.csv`、`habit_entries.csv`、`daily_check_ins.csv`、`weekly_reviews.csv`、`notification_settings.csv`、`ai_results.csv`、`README.txt`)を入れる。UTF-8(BOM 付きで Excel でも文字化けしない)、改行は CRLF、先頭行は項目名(JSON と同じ名前。`notification_settings.csv` の `quietHours` だけは `quietHoursStart`/`quietHoursEnd` の 2 列に分け、quiet hours がなければ空)。入れ子の値(`summary`、`result`、`daysOfWeek`)は JSON 文字列として 1 セルに入れる。`README.txt` に各ファイルの説明と、`schemaVersion` を書く。
- CSV の数式対策: セルの先頭が `=`、`+`、`-`、`@`、タブ、CR のときは、先頭に `'` を付けて、表計算ソフトが数式として実行しないようにする。引用符・カンマ・改行を含むセルは `"` で囲み、`"` は `""` にする。数値(`mood` など)は文字列化のみで、先頭が `-` の負数は数式対策の対象外にする(値が数値型のもの)。
- ZIP は圧縮なしの保存形式(CRC-32 付き)。固定の更新日時(エクスポート時刻)を持ち、パスはファイル名のみ(ディレクトリを含まない)。

### EXP-007 期限切れの削除

- `cleanupExpiredDataExportsUseCase` は、`status = 'ready' AND expires_at <= now` のエクスポートの成果物(`data_export_artifacts`)を削除し、`status = 'expired'` にする。あわせて、60 分以上更新のない `queued`/`running` を `failed(worker_error)` にする。あわせて、`failed`/`expired` になってから 7 日(`updated_at` 基準)を過ぎた行自体を削除する(監査ログは残る)。1 回の実行は最大 200 件。冪等で、重複・並行起動で例外にならない。
- アカウント削除(PR-A)では、`users` の削除で `data_exports` と成果物が `ON DELETE CASCADE` により削除される。

### EXP-008 画面

- `/account/export`(active な Member): 説明(含まれるデータ、含まれないデータ、ダウンロードの期限 24 時間)、形式の選択(JSON / CSV)、パスワード、「エクスポートを作成する」。作成後は直近の一覧(状態、形式、作成日時、サイズ、期限)を表示し、`queued`/`running` の間は 2 秒間隔で状態を更新する(`ready` か `failed` になったら止める)。`ready` なら「ダウンロード」リンク。失敗・期限切れは固定の文言で表示する。
- プロフィール画面に「データをエクスポートする」への導線を置く。パスワードは送信した時点で state から消し、失敗時も復元しない。エラーは固定文言(再認証失敗、制限中、実行中、頻度の上限、通信失敗)。

## 業務ルールと不変条件

- EXP-INV-001(所有者限定): 一覧・状態・ダウンロードの全 query が `user_id = actor` を含む。他人の ID は `404` で存在を区別しない。worker は job の所有者の ID を全 query に渡す。
- EXP-INV-002(許可リスト): 出力は「出力するデータ」の項目に限る。収集は項目を列挙し、`SELECT *` や行のそのままのシリアライズを使わない。テストが、出力に含めてはいけない値(ハッシュ、token、秘密)が現れないことを検査する。
- EXP-INV-003(再認証と制限): 作成にはパスワードの再入力が必須。失敗は `reauth` として 5 回/15 分で制限(アカウント削除と共有。通常のログインとは独立)。ダウンロードは session の本人確認のみ(再認証は作成時)。
- EXP-INV-004(冪等と競合): ジョブの状態遷移は条件付き更新の単一文。`queued`/`running` の同時存在は DB の部分 unique index で 1 件に制限する。確定は `running` のときだけ成立する。
- EXP-INV-005(期限): 完成から 24 時間(`DATA_EXPORT_TTL_HOURS`)。定数は Domain の 1 箇所のみ。期限の判定(`now >= expires_at`)は Domain の関数で、API の応答・ダウンロードの可否・定期ジョブの対象判定が同じ関数/同値の条件を使う。
- EXP-INV-006(一貫性): 収集は 1 つの `REPEATABLE READ` transaction。
- EXP-INV-007(内容の非露出): データの内容(習慣名、メモ、AI の結果)、ファイルの本文、例外メッセージ、メールを、ログ・監査・エラー応答・queue message に出さない。ジョブのログは件数と状態のみ。
- EXP-INV-008(上限): 成果物は 20 MiB(`DATA_EXPORT_MAX_BYTES`)まで。超えたら生成を失敗にし、部分的なファイルを保存しない。
- EXP-INV-009(監査): 作成とダウンロードを `audit_logs` に追記する。記録するのは actor(`user:{公開 ID}`)、action、対象(`data_export` と公開 ID)、request ID、IP の不可逆化表現のみ。

## 状態遷移

| 現在           | イベント                                  | 次         | 備考                                               |
| -------------- | ----------------------------------------- | ---------- | -------------------------------------------------- |
| (なし)         | 作成(再認証あり)                          | queued     | 実行中のものがある場合は 409、頻度超過は 429       |
| queued         | worker が claim                           | running    | lease あり(切れた running も再 claim できる)       |
| running        | 確定                                      | ready      | 成果物を保存、`expires_at` を設定                  |
| running        | 再試行不能の失敗 / 上限超過               | failed     | `generation_failed` / `too_large` / `worker_error` |
| running        | 一時的な失敗                              | queued     | 受信回数の上限まで再配送                           |
| queued         | 投入の失敗                                | failed     | `enqueue_failed`                                   |
| queued/running | 60 分以上更新なし(作成時または定期ジョブ) | failed     | `worker_error`。停止したとみなす                   |
| ready          | 新しいエクスポートの作成                  | expired    | 成果物を削除                                       |
| ready          | 期限(24 時間)到来 + 定期ジョブ            | expired    | 成果物を削除。期限後のダウンロードは時刻で 410     |
| failed/expired | 7 日経過 + 定期ジョブ                     | (行を削除) |                                                    |

## 受け入れ基準

```gherkin
Scenario: JSON のエクスポートを作成してダウンロードする
  Given 習慣・記録・チェックイン・週次レビュー・通知設定を持つ Member
  When 正しいパスワードで POST /me/exports {format: "json"} を送る
  Then 202 で status=queued のエクスポートが返る
  And worker の処理後、GET /me/exports で status=ready、expiresAt が完成の 24 時間後になる
  And GET /me/exports/{id}/download で JSON が返り、自分のデータが含まれる
  And JSON に passwordHash、sessionToken、MFA の秘密、内部 ID、他ユーザーの情報は含まれない

Scenario: CSV のエクスポートは ZIP で、Excel で開ける
  When format=csv で作成してダウンロードする
  Then application/zip の ZIP に各 CSV と README.txt が入っている
  And 各 CSV は BOM 付きの UTF-8 で、日本語が文字化けしない
  And メモが "=SUM(1,1)" のとき、セルは "'=SUM(1,1)" になる
  And カンマ・引用符・改行を含む値が正しくエスケープされる

Scenario: 再認証に失敗すると作成されない
  When 誤ったパスワードで POST /me/exports を送る
  Then 403 reauthentication_failed で、エクスポートは作成されない
  And 5 回続くと、正しいパスワードでも 429 too_many_attempts になる

Scenario: 実行中は新規に作れない
  Given queued または running のエクスポートがある
  When 再度作成する
  Then 409 export_in_progress

Scenario: 作成頻度の上限
  Given 直近 24 時間に 5 件のエクスポートを作成している
  When 作成する
  Then 429 export_rate_limited

Scenario: 他人のエクスポートは見えない
  Given ユーザー A の ready のエクスポート
  When ユーザー B が A の ID でダウンロードする
  Then 404 export_not_found(存在しない ID と同じ応答)
  And B の GET /me/exports に A のものは現れない

Scenario: 期限切れ
  Given 完成から 24 時間以上経過したエクスポート
  When ダウンロードする
  Then 410 export_expired
  And 定期ジョブの後は成果物が DB から削除され、status=expired

Scenario: ジョブの安全性
  When 同じ message が重複配送される、または 2 つの worker が同時に処理する
  Then 確定は 1 回で、成果物は 1 件、例外にならない
  And 上限(20 MiB)を超えるデータは failed(too_large)で、部分的なファイルは保存されない

Scenario: 一貫したスナップショット
  When 収集中に別の接続が記録を追加・更新する
  Then エクスポートは収集開始時点の状態で、追加の一部だけが混ざらない

Scenario: 削除予約中は使えない
  Given 削除を要求済みのユーザーが再ログインしている
  When POST /me/exports を送る
  Then 401

Scenario: アカウント削除でエクスポートも消える
  Given ready のエクスポートを持つユーザーの削除期限が到来した
  When 削除ジョブが実行される
  Then data_exports と成果物も削除される

Scenario: 画面
  When Member が /account/export で形式を選びパスワードを入力して作成する
  Then 一覧に queued → ready と更新され、ダウンロードできる
```

## 認可マトリクス

| 操作                          | Guest | Member(active) | Member(他人) | Member(削除予約中) |
| ----------------------------- | ----: | -------------: | -----------: | -----------------: |
| POST /me/exports              |   401 |    Yes(再認証) |     到達不可 |                401 |
| GET /me/exports               |   401 |            Yes |     到達不可 |                401 |
| GET /me/exports/{id}/download |   401 |  Yes(自分の分) |          404 |                401 |
| ジョブの処理・期限切れの削除  |     — |              — |            — |                  — |

path・body にユーザーを含めない(ダウンロードは自分の分のみ到達)。ジョブの処理・削除は Worker(DB 権限)のみ。

## APIとイベント

共通: base path `/api/v1`、JSON(ダウンロードを除く)、未知キー拒否、Problem Details、`Cache-Control: no-store`。`POST` は Origin 検証(`403 invalid_origin`)、`Content-Type: application/json`(`415`)、body 上限 1 KiB(`413`)。契約の正本は `packages/contracts/src/data-export.ts` の runtime schema と本 Spec(OpenAPI 生成基盤は未導入)。

| Method/Path                     | 入力                       | 成功 | エラー                                                                                                                                           |
| ------------------------------- | -------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /me/exports`              | body: `password`, `format` | 202  | 401, 403(reauthentication_failed, invalid_origin), 404, 409(export_in_progress), 413, 415, 422, 429(too_many_attempts, export_rate_limited), 503 |
| `GET /me/exports`               | なし                       | 200  | 401, 404                                                                                                                                         |
| `GET /me/exports/{id}/download` | path                       | 200  | 401, 404(export_not_found, user_not_found), 409(export_not_ready), 410(export_expired)                                                           |

- 422 は `validation_failed`(`format` が `json`/`csv` 以外、`password` が空・文字列以外・128 文字超)。`503` は `export_unavailable`(投入に失敗した場合)。
- queue message(`{ version: 1, exportId }`)は SQS の標準 message として扱う。部分失敗は `batchItemFailures` で返す(T-303 と同じ)。Events は発行しない。

### Resource: DataExport

```json
{
  "id": "…",
  "status": "ready",
  "format": "json",
  "requestedAt": "2026-10-13T03:00:00.000Z",
  "expiresAt": "2026-10-14T03:00:12.000Z",
  "byteSize": 12480,
  "failureCode": null
}
```

## データとMigration

Migration `t404_data_export`(expand のみ。新規テーブル):

- `data_exports`: `id`(bigint identity)、`public_id`(uuid、unique)、`user_id`(FK、`ON DELETE CASCADE`)、`format`(`json|csv`)、`status`(`queued|running|ready|failed|expired`)、`failure_code`、`byte_size`、`file_name`、`content_type`、`created_at`、`updated_at`、`completed_at`、`expires_at`。CHECK: `format`・`status` の値域、`ready` なら `expires_at`・`byte_size`・`completed_at`・`file_name`・`content_type` がすべて設定済み(`expired` は表示のため値を残してよい)、`(status = 'failed') = (failure_code IS NOT NULL)`、`byte_size >= 0`。
- 部分 unique index `data_exports_user_active_uidx (user_id) WHERE status IN ('queued','running')`(EXP-INV-004)。`(user_id, created_at DESC)` の index(一覧・頻度の上限)。`(expires_at) WHERE status = 'ready'` の部分 index と `(updated_at) WHERE status IN ('failed','expired')` の部分 index(定期ジョブのスキャン)。FK `user_id` は `(user_id, created_at)` の index の先頭列で兼ねる。
- `data_export_artifacts`: `export_id`(PK かつ FK → `data_exports.id`、`ON DELETE CASCADE`)、`content`(bytea、NOT NULL)。成果物を別テーブルにして、一覧・状態の query が本体を読まないようにする。
- `updated_at` は既存の `set_updated_at` trigger を付ける。状態の遷移は条件付き更新の単一文で行う。
- 既存のテーブルは変更しない。rollback はアプリの revert(必要なら forward Migration でテーブルを削除する)。fresh と upgrade の両方を Integration Test で検証する。
- 保存先の将来の差し替え: 成果物の保存・読み出しは repository の内側に閉じる。S3 に移す際は `data_export_artifacts` を使わず、`data_exports` にオブジェクトキーを持たせる Migration を別途追加する。

## 失敗・境界ケース

- 収集・生成の途中で例外 → 一時的なら再配送、上限超過後は `failed(worker_error)`。生成そのものの失敗(データの形が想定外など)は `failed(generation_failed)`。
- データが空(習慣も記録もない): 空の配列・空の CSV(ヘッダのみ)で成功する。
- 20 MiB を超える: `failed(too_large)`。部分的なファイルは保存しない。
- 非常に長いメモ・日本語・絵文字・改行・引用符・NUL 以外の制御文字を含む値: JSON は標準のエスケープ、CSV は引用して出す。
- ダウンロード中にアカウントが削除された: 成果物が消えているため `404`。
- 期限と同時刻のダウンロード: `now >= expires_at` は期限切れ(`410`)。
- worker が止まっている間: `queued` のまま。画面は「処理中」を表示し続ける。60 分を過ぎると停止とみなして失敗になり、利用者は作り直せる。Runbook に滞留時の確認手順を書く。
- 同じユーザーが 2 つのタブで同時に作成: 部分 unique index で 1 件だけが成立し、もう一方は `409`。
- session の user が削除済み → `404 user_not_found`。DB 制約違反(アプリをすり抜けた場合)→ 内部エラー(500)。内部詳細は応答に含めない。

## セキュリティとプライバシー

- 収集・保持データ: 本人のデータの複製(成果物)を最長 24 時間 DB に保持する。外部送信なし。メールで送らない。
- ログ禁止データ: パスワード、データの内容、成果物、メール、queue message の内容(job ID のみ)。ジョブのログは状態と件数のみ。
- 脅威と対策:
  - 乗っ取られた session による持ち出し: 作成に再認証(パスワード)を必須にし、失敗を制限する。短い期限(24 時間)、頻度の上限、監査。
  - IDOR: 全 query に `user_id` を含め、他人の ID は `404`(存在を区別しない)。
  - CSRF: 作成は Origin 検証 + `application/json`。ダウンロードは GET だが、副作用は監査の追記のみで、レスポンスを読めるのは同一オリジンの本人だけ(`SameSite=Lax` の cookie、CORS なし)。
  - XSS・コンテンツ種別の悪用: `Content-Disposition: attachment`、`X-Content-Type-Options: nosniff`、固定のファイル名(ユーザー入力を含めない)。
  - CSV インジェクション: 数式の先頭文字の無害化(EXP-006)。
  - 過剰な収集: 許可リストの列挙、`SELECT *` なし、テストで機密値の非出力を検査。
  - 資源の枯渇: 実行中は 1 件、24 時間に 5 件、20 MiB の上限、分割読み込み。
- 保持: 成果物は完成から 24 時間で削除対象(定期ジョブ)。バックアップに残るデータの保持期間は T-502。

## AI要件

N/A。AI を利用しない。出力に含める AI の結果(`ai_jobs.result_json`)は、本人に対して既に表示している構造化出力であり、入力や prompt は含めない。

## 可観測性と運用

- ログ: 処理ジョブとクリーンアップは件数・状態のみ(`export.process`、`export.cleanup`)。route に独自ログを追加しない。
- Metrics/Alerts: `queued` の滞留(古い `queued` の件数)、`failed` の増加、クリーンアップの停止は T-501 の observability 設計で扱う。Runbook([data-export.md](../runbooks/data-export.md))に確認用のクエリを書く。
- 展開/ロールバック: ジョブの処理とクリーンアップの worker は Feature Flag `DATA_EXPORT_ENABLED`(既定は無効)で無効のまま配置する。Web/API は、`EXPORT_QUEUE_DRIVER=sqs` が未実装の間はローカル/E2E の `inline` のみで動き、本番では `inline` を拒否する(誤って本番で動かさない)。Migration は expand のみで、revert でコードを戻せる。

## テスト対応表

| 要件         | Unit                                                                                                                      | Integration(実 PostgreSQL)                                                                        | E2E                                               |
| ------------ | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| EXP-001      | 再認証・制限・実行中・頻度・投入失敗の順序(fake)、handler の 202/401/403/409/413/415/422/429/503                          | 部分 unique index による 1 件制限、並行作成で 1 件、頻度の数え方、新規作成で古い ready が expired | 作成、誤パスワード、制限、実行中                  |
| EXP-002      | 状態遷移(claim/確定/再試行/上限/失敗)、重複配送、batch の部分失敗                                                         | 並行 claim で 1 回、lease、確定の原子性、終端の不変                                               | (inline で ready まで)                            |
| EXP-003      | 一覧の期限の表示判定                                                                                                      | 他ユーザーの混在なし、直近 5 件                                                                   | 一覧・状態の更新                                  |
| EXP-004      | 所有者・状態・期限の振り分け、ヘッダー                                                                                    | 他人の ID が 404、成果物の読み出し、監査が先                                                      | JSON/ZIP のダウンロード、他人の 404、期限切れ 410 |
| EXP-005/006  | JSON の構造、CSV のエスケープ・数式の無害化・BOM・CRLF(性質テスト)、ZIP(CRC-32、構造、往復)、許可リスト(機密値が現れない) | スナップショット(収集中の更新が混ざらない)、全データの収集、空のデータ                            | 内容の検証(含む/含まない)                         |
| EXP-007      | クリーンアップの対象判定(期限境界、件数上限、冪等)                                                                        | 成果物の削除、7 日後の行の削除、並行実行                                                          | N/A                                               |
| EXP-INV-005  | 期限計算の性質テスト、境界                                                                                                | CHECK(ready の整合)                                                                               | N/A                                               |
| EXP-008      | 画面の固定文言、ポーリングの停止条件                                                                                      | -                                                                                                 | 作成からダウンロードまで、導線                    |
| 削除との連動 | -                                                                                                                         | アカウント削除で `data_exports`・成果物が消える、全 FK が CASCADE(既存の検査に含まれる)           | N/A                                               |

テスト品質の 3 観点: (1) プロパティベース(CSV の往復とエスケープ、数式の無害化、ZIP の往復、期限計算、許可リスト)、(2) 変異テスト(Stryker 未導入。許可リストの項目、期限の境界、所有者条件、数式の先頭文字、CRC、claim の条件を手動で壊して検知を確認)、(3) 敵対的審査(他人のダウンロード、期限、再認証の迂回、CSV インジェクション、機密値の混入、重複・競合、資源の枯渇を攻撃者の視点で見直して結果を報告)。Fake/Stub 方針: Application の unit は in-memory fake と固定 Clock、収集は fake の data source。Integration は Testcontainers。fixture は架空データのみ。

## 未決事項

実装をブロックしない事項:

- **S3 と署名付き URL**: T-501/T-502。インフラが整ったら、保存先を S3 に差し替える(成果物の保存は repository の内側)。
- **含める項目の追加・削除**: `account.email` は本人の確認済みアドレスとして含める。不要と判断したら、許可リストから外すだけで変更できる。
- **通知の配送履歴を含めるか**: 運用情報として現時点では含めない。要望があれば別途検討する。
- **ダウンロード期限 24 時間・頻度 5 件/日・上限 20 MiB**: 暫定値(定数のみ変更)。`docs/10` に記録する。
- **メールでのダウンロード通知**: T-405 以降(取引メールの枠組み)。

## 実装準備状況

Status: Ready
Reviewed at: 2026-10-13
Reviewed by: —

| Gate                 | Result | Evidence                                                                                                                                |
| -------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| Product              | Pass   | 目的、成功指標、範囲/対象外。`docs/02` UC-17、`docs/09` T-404                                                                           |
| Specification        | Pass   | EXP-001〜008、EXP-INV-001〜009、状態遷移、受け入れ基準。未決事項は非ブロック                                                            |
| Domain and Time      | Pass   | 期限は UTC の経過時間(EXP-INV-005)。Clock 注入。冪等・競合は条件付き更新と部分 unique index(EXP-INV-004)、スナップショット(EXP-INV-006) |
| API and Data         | Pass   | APIとイベント、データとMigration(新規テーブルのみ、CHECK・index・FK の確認、fresh/upgrade 検証、rollback)                               |
| Security and Privacy | Pass   | セキュリティとプライバシー、認可マトリクス(再認証、IDOR、CSV インジェクション、許可リスト、保持、ログ禁止、資源の上限)                  |
| AI                   | N/A    | AI を利用しない。出力する AI の結果は既存の構造化出力のみ                                                                               |
| Testing              | Pass   | テスト対応表(Unit/Integration/E2E、3 観点)                                                                                              |
| Operations           | Pass   | 可観測性と運用(ログは件数のみ、Runbook、Feature Flag、本番で inline を拒否、rollback)                                                   |
| Planning             | Pass   | [../plans/data-export.md](../plans/data-export.md)                                                                                      |

### 受容リスク

- 成果物を DB に置く(S3 未導入)。24 時間で削除されるが、その間は DB のバックアップにも含まれうる(T-502 で保持期間を決める)。
- 実 SQS・Lambda は T-501 まで未配置。それまでは inline(ローカル/E2E 用)のみで、本番相当の環境ではエクスポートを動かせない。
- ダウンロードは session の本人確認のみ(再認証は作成時)。作成後 24 時間は、乗っ取られた session でダウンロードされうる(作成に再認証、短い期限、監査で限定)。
- 作成・完成のメール通知がない(T-405 以降)。
- Rate limit は作成頻度(5 件/日)と再認証のみ。ダウンロードの回数制限はない(監査に残る)。

### 未決事項

なし(上記は非ブロック)
