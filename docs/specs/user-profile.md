# User Profile Spec

Status: Ready
Owner: TBD
Last updated: 2026-10-02
Change classification: Standard
Roadmap Task: T-102

## Goal

認証済みの Member が自分のプロフィール(表示名、タイムゾーン、ロケール、週の開始曜日)を取得・更新できるようにする(01-product-requirements.md 機能要件 2、UC-03、オンボーディング手順 2)。タイムゾーンは習慣日付の判定・予定機会生成(T-201 以降)の基準になるため、IANA ID として厳密に検証して保存する。actor は T-101 が提供する session からのみ取得する([auth-adapter.md](auth-adapter.md) AUTH-009)。

## Success Metrics

- 新規 Member が初回の `GET /api/v1/me` と `PATCH /api/v1/me` だけでオンボーディングのプロフィール設定(表示名とタイムゾーン)を完了できる。
- 不正なタイムゾーン・表示名等はすべて 422 + `fieldErrors` で拒否され、DB へ保存されない(Unit/Integration Test で検証)。
- あるユーザーの操作が他ユーザーの `user_profiles` 行を読み書きできない(Integration Test で検証)。
- T-201 以降が「ユーザーの IANA タイムゾーン」を `GET`/Application API 経由でそのまま再利用でき、検証ロジックを再実装する必要がない。

## Scope

- Domain: プロフィールの値オブジェクト(`DisplayName`、`IanaTimezone`、`Locale`、`WeekStartsOn`)と検証、既定プロフィール、変更の検証(`validateProfileChanges`)。
- Application: `getMyProfile`、`updateMyProfile` use case、`ProfileRepositoryPort`、所有権 policy。
- Infrastructure: `PrismaProfileRepository`(`user_profiles` の find/ensure/update)。
- Presentation: `GET/PATCH /api/v1/me` Route Handler、session からの actor 取得、Problem Details 変換、`Origin` 検証。
- DB: `user_profiles` の制約追加(`display_name` を nullable 化、値域 CHECK)。
- Contracts: request/response の runtime schema。

## Out of Scope

- 通知設定(`notification_settings`、UC-14)。機能要件 2 の「通知設定」は別 endpoint `/notification-settings` で扱い、T-401 で設計・実装した（[notification-preferences.md](notification-preferences.md)）。
- `DELETE /me`、`GET /me/export`(T-404)。
- email 変更・表示、パスワード変更(再認証を伴う sensitive action。別 Spec)。
- 週の開始曜日の既定値の最終決定(10-decisions-and-open-questions.md P1)。本 Spec は暫定既定値を置く(Open Questions 参照)。
- 日本語/英語の対応範囲の最終決定(同 P1)。本 Spec は `ja`/`en` を許可する暫定仕様とする。
- timezone 変更を受けた予定機会・集計の再計算ルール(T-201 以降。本タスクは値の保存のみ)。
- Playwright E2E(onboarding profile)。Playwright は未導入であり、AGENTS.md の方針どおり導入(T-101 の E2E シナリオ着手時)までは対象外とする。Integration Test と Route Handler 単体テストで代替し、E2E は導入後のタスクで追加する。
- OpenAPI ドキュメントの生成基盤。リポジトリには未導入のため、契約は zod の runtime schema(`packages/contracts`)と本 Spec を正本とし、基盤導入時に schema から導出する(ADR-009)。
- API の rate limit 実装(P2 未決。Security 節参照)。

## Actors and Preconditions

| Actor                  | Preconditions                                            |
| ---------------------- | -------------------------------------------------------- |
| Guest(未認証)          | なし。`/api/v1/me` は常に 401                            |
| Member(email 確認済み) | login 済みで、有効な session から actor user ID を取得可 |

email 未確認の Member は login できない(AUTH-005)ため、本 Spec では email 確認済みの Member のみが対象となる。

## Functional Requirements

### PROF-001 プロフィール取得

- 認証済み Member は `GET /api/v1/me` で自分のプロフィールを取得できる。
- プロフィール行が未作成の場合は、既定値で作成した上で返す(遅延作成、Data and Migration 参照)。結果として、どの Member も常にプロフィールを取得できる。
- 返す項目は `displayName`(未設定は `null`)、`timezone`、`locale`、`weekStartsOn`、`updatedAt`。email その他の認証情報・内部 ID は返さない。

### PROF-002 プロフィール部分更新

- 認証済み Member は `PATCH /api/v1/me` で次のいずれか 1 つ以上を更新できる: `displayName`、`timezone`、`locale`、`weekStartsOn`。
- 指定した項目のみ更新し、指定しない項目は変更しない(partial update)。`null` や空 body は受け付けない。
- 成功時は更新後のプロフィール全体を `200` で返す。
- 同一値での更新も成功する(冪等)。

### PROF-003 表示名の検証

- 前後の空白を除去し、Unicode NFC 正規化した後の文字列を保存する。
- 長さは 1〜50 文字(code point 単位)。
- 制御文字(Unicode General Category Cc: U+0000–U+001F、U+007F–U+009F)、行区切り・段落区切り(U+2028/U+2029)、双方向制御文字(U+202A–U+202E、U+2066–U+2069)を含む場合は拒否する。
- HTML は解釈しない。保存は文字列のまま行い、出力時の escaping は Presentation(React)に委ねる。サーバーは表示名を HTML として出力しない。

### PROF-004 タイムゾーンの検証

- タイムゾーンは IANA タイムゾーン ID(例: `Asia/Tokyo`、`America/New_York`、`UTC`)のみ許可する。
- 次は拒否する: 空文字、64 文字超、UTC オフセット表記(`+09:00`)、略称(`JST`、`EST`)、未知の ID、IANA ID の形式に合わない文字列。
- 保存した ID は後続の予定機会計算(T-201 以降)が `Intl` で解釈するため、実行環境の ICU(`Intl.DateTimeFormat`)が受理することを検証条件とする。
- ID は `Area/Location` 形式(各セグメントは英大文字で始まる)または `UTC` のみ許可する。ICU が受理する略称(`JST`、`EST`、`GMT` 等。`EST` は別地域へ解決されるなど曖昧)、小文字始まり(`asia/tokyo`)、大文字小文字だけが異なる誤記(`America/New_york`)は拒否する。
- ID の正規化(置換)は行わず、検証済みの入力をそのまま保存する。ICU の正規 ID は旧名(`Asia/Katmandu` 等)を返すことがあり、ブラウザが送る現行名(`Asia/Kathmandu`)を拒否してしまうため、固定の許可リストは採用しない(別名 `Asia/Kolkata` や `US/Pacific` は ICU が受理するため入力どおり保存する)。
- 検証は Domain の純粋関数で行い、DB・ネットワークに依存しない。

### PROF-005 ロケールと週の開始曜日の検証

- `locale` は `ja` または `en` のみ許可する(暫定。Open Questions 参照)。
- `weekStartsOn` は 0(日曜)〜6(土曜)の整数のみ許可する。

### PROF-006 既定プロフィール

- 遅延作成時の既定値: `displayName = null`、`timezone = "Asia/Tokyo"`、`locale = "ja"`、`weekStartsOn = 1`(月曜)。
- 既定タイムゾーンは日本語ユーザー中心の法務基準([ADR-006](../adr/ADR-006-legal-baseline.md))に基づく暫定値であり、オンボーディングで Member が明示設定する前提である。
- `displayName` が `null` であることがオンボーディング未完了の目印となる。

### PROF-007 認証と所有権

- `/api/v1/me` は session から取得した actor user ID のみを対象とする。request の path・query・body に対象ユーザーを指定する手段を持たない。
- 認証されていない(session なし、期限切れ、失効)場合は `401`。
- すべての DB 問い合わせは actor user ID を条件に含める。取得後の所有者チェックだけに依存しない。
- actor に対応する user が存在しない(削除済み等)場合は、存在を漏らさない `404` を返す。

## Business Rules and Invariants

- PROF-INV-001: `user_profiles` は user あたり最大 1 行(`user_id` PK)。並行した初回アクセスでも重複・エラーにならず、1 行のみ作成される。
- PROF-INV-002: 保存される `timezone` は常に Domain の検証(PROF-004)を通過した IANA ID である。
- PROF-INV-003: 保存される `displayName` は `null` または PROF-003 を満たす 1〜50 文字の文字列である(DB CHECK でも二重に強制)。
- PROF-INV-004: `weekStartsOn` は常に 0〜6(DB CHECK でも二重に強制)。
- timezone の変更は「変更時点以降」の予定機会に適用し、既存の `habit_date` は書き換えない(02-use-cases.md 例外・競合)。本タスクは値を保存するのみで、過去データには一切触れない。消費側(T-201 以降)は計算時点の現在値を参照し、必要なら `weekly_reviews.timezone_snapshot` 等でスナップショットを保持する。
- 更新競合: プロフィールは 1 人の所有者のみが更新し、各項目は互いに独立した partial update であるため、`version`/`If-Match` による楽観ロックは導入せず、項目単位の last-write-wins とする(05-api-and-ai-design.md の楽観ロック原則からの意図的な逸脱。理由: 複数ユーザー間の競合が存在せず、`user_profiles` に version 列を追加するコストに見合う利益がない)。複数項目を持つ集約へ拡張する場合は再評価する。

## State Transitions

| Current            | Action            | Next                                       | Rejected when                         |
| ------------------ | ----------------- | ------------------------------------------ | ------------------------------------- |
| プロフィール行なし | GET /me           | 既定プロフィールで作成(`displayName` null) | actor の user が存在しない(404)       |
| プロフィール行なし | PATCH /me         | 既定で作成後、指定項目を更新               | 検証違反(422)、user が存在しない(404) |
| プロフィールあり   | PATCH /me         | 指定項目を更新                             | 検証違反(422)、user が存在しない(404) |
| 任意               | GET/PATCH(未認証) | 変更なし                                   | 常に 401                              |

## Acceptance Criteria

```gherkin
Scenario: 初回の GET /me は既定プロフィールを返す
  Given email 確認済みでログイン済みの Member のプロフィール行が未作成である
  When GET /api/v1/me を呼ぶ
  Then 200 で displayName が null、timezone "Asia/Tokyo"、locale "ja"、weekStartsOn 1 が返り、プロフィール行が 1 件作成される

Scenario: オンボーディングで表示名とタイムゾーンを設定する
  Given ログイン済みの Member である
  When PATCH /api/v1/me に displayName "たなか" と timezone "America/New_York" を送る
  Then 200 で更新後のプロフィールが返り、locale と weekStartsOn は変更されない

Scenario: 不正なタイムゾーンは拒否される
  Given ログイン済みの Member である
  When PATCH /api/v1/me に timezone "JST" を送る
  Then 422 で fieldErrors.timezone が返り、プロフィールは変更されない

Scenario: 現行名の IANA ID は入力どおり保存される
  Given ログイン済みの Member である
  When PATCH /api/v1/me に timezone "Asia/Kathmandu" を送る
  Then 200 で timezone "Asia/Kathmandu" が保存・返却される

Scenario: 表示名の制約違反は拒否される
  Given ログイン済みの Member である
  When PATCH /api/v1/me に 51 文字の displayName、または制御文字を含む displayName を送る
  Then 422 で fieldErrors.displayName が返る

Scenario: 空の更新・未知キーは拒否される
  Given ログイン済みの Member である
  When PATCH /api/v1/me に {} または未知キーを含む body を送る
  Then 422 が返り、プロフィールは変更されない

Scenario: 未認証は 401
  Given session を持たない Guest である
  When GET または PATCH /api/v1/me を呼ぶ
  Then 401 が返る

Scenario: 他ユーザーのプロフィールは読み書きできない
  Given Member A と Member B のプロフィールが存在する
  When Member A として PATCH /api/v1/me を呼ぶ
  Then Member A のプロフィールのみが更新され、Member B のプロフィールは変更されない

Scenario: 別 Origin からの PATCH は拒否される
  Given ログイン済みの Member の cookie を持つブラウザが別 Origin のページを開いている
  When そのページから PATCH /api/v1/me が送られる(Origin ヘッダが許可 Origin と異なる)
  Then 403 が返り、プロフィールは変更されない
```

## Authorization Matrix

| Operation        | Guest | Member | Admin | Ownership rule                                      |
| ---------------- | ----: | -----: | ----: | --------------------------------------------------- |
| GET /api/v1/me   |    No |    Yes |    No | session の actor user ID の行のみ(対象指定手段なし) |
| PATCH /api/v1/me |    No |    Yes |    No | 同上                                                |

Admin による他ユーザーのプロフィール参照・変更は本 Spec の対象外(T-403)。

## API and Events

共通仕様は [auth-adapter.md](auth-adapter.md) API and Events 節と同じ(`Content-Type: application/json`、未知キー拒否、エラーは Problem Details `code`/`message`/`fieldErrors`/`requestId`)。base path は `/api/v1`([ADR-009](../adr/ADR-009-api-style.md))。event は発行しない(N/A)。

### `GET /api/v1/me`

| 項目     | 内容                                                                      |
| -------- | ------------------------------------------------------------------------- |
| 認証要否 | 必要(session)                                                             |
| 入力     | なし                                                                      |
| 正常応答 | `200 OK`、`ProfileResponse`                                               |
| エラー   | `401`(`code: "unauthenticated"`)、`404`(`code: "not_found"`、user 不存在) |

`ProfileResponse`:

```json
{
  "displayName": "たなか",
  "timezone": "Asia/Tokyo",
  "locale": "ja",
  "weekStartsOn": 1,
  "updatedAt": "2026-10-02T00:00:00.000Z"
}
```

`displayName` は未設定時 `null`。`updatedAt` は UTC の ISO 8601。

### `PATCH /api/v1/me`

| 項目     | 内容                                                                                                                                                                                     |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 認証要否 | 必要(session)                                                                                                                                                                            |
| 入力     | `displayName`(string)、`timezone`(string)、`locale`(string)、`weekStartsOn`(integer)。すべて任意だが 1 つ以上必須。未知キー拒否                                                          |
| 入力上限 | body 4096 byte、`displayName` raw 200 文字、`timezone` 64 文字、`locale` 16 文字                                                                                                         |
| 正常応答 | `200 OK`、更新後の `ProfileResponse`                                                                                                                                                     |
| エラー   | `401` `unauthenticated`、`403` `forbidden_origin`(Origin 不一致)、`404` `not_found`、`413` `payload_too_large`、`415` `unsupported_media_type`、`422` `validation_failed`(`fieldErrors`) |

`validation_failed` の `fieldErrors` キーは request のフィールド名(`displayName`/`timezone`/`locale`/`weekStartsOn`)、値は固定の日本語メッセージ。入力値そのもの(自由記述)をエラー応答へ含めない。

## Data and Migration

- 既存 `user_profiles`(`user_id` PK/FK `ON DELETE CASCADE`、`display_name`、`timezone`、`locale`、`week_starts_on`、timestamps、`updated_at` trigger)をそのまま使用する。FK は PK と兼用のため追加 index 不要。
- Migration(expand、後方互換): ① `display_name` の `NOT NULL` を外す(プロフィール未設定を `NULL` で表す)、② CHECK 制約を追加: `week_starts_on BETWEEN 0 AND 6`、`display_name IS NULL OR char_length(display_name) BETWEEN 1 AND 50`、`char_length(timezone) BETWEEN 1 AND 64`、`locale IN ('ja','en')`。`user_profiles` は T-102 以前にアプリが書き込んでおらず既存行は存在しない前提のため backfill 不要。万一既存行が制約違反の場合は migration が失敗するため、適用前確認が必要(Plan 参照)。
- 遅延作成: 行が存在しない場合、`INSERT ... ON CONFLICT (user_id) DO NOTHING`(Prisma `createMany({ skipDuplicates: true })`)で既定値を作成し、並行アクセスでも重複・例外を生じさせない(PROF-INV-001)。T-101 の signup transaction は変更しない(UC-01「プロフィールが作成される」は初回アクセス時の遅延作成で満たす)。
- Rollback/forward fix: CHECK 制約の DROP と `NOT NULL` 復元(`NULL` 行が存在する場合は事前に既定値で埋める)で戻せる。原則は forward fix。
- 保持期間: account が存在する限り保持し、account 削除時は FK cascade で削除される(T-404 の削除フローに従う)。

## Failure and Edge Cases

- 初回 GET/PATCH の並行実行 → 行は 1 つのみ作成され、どちらも成功する(PROF-INV-001)。
- 表示名の境界: 0 文字(空白のみ含む)、1 文字、50 文字、51 文字、サロゲートペア(絵文字)の code point 数え、NFC 正規化前後の長さ。
- タイムゾーン: 大文字小文字違い(`asia/tokyo`、`America/New_york`)、別名(`Asia/Kolkata`)、`UTC`、`GMT`、`+09:00`、`JST`、`EST`、空文字、65 文字以上、制御文字を含む文字列、DST を持つ地域(`America/New_York`)と持たない地域(`Asia/Tokyo`)、半時間・45 分オフセット(`Asia/Kathmandu`)、`Australia/Lord_Howe`。
- body が JSON でない/配列/型違い → `422`。巨大 body → `413`(JSON parse 前に拒否)。
- session が期限切れ・失効 → `401`(AUTH-009)。
- DB 障害 → `500`。内部エラー詳細は返さない。

## Security and Privacy

- Data collected: 表示名(自由記述に準ずる個人情報)、タイムゾーン、ロケール、週の開始曜日。
- Data sent externally: なし。AI provider へは本 Spec の項目(特に表示名)を送らない(05-api-and-ai-design.md 入力最小化)。AI 用途にタイムゾーンが必要になった場合は別 Spec で最小化して扱う。
- Data forbidden in logs: 表示名、リクエスト/レスポンス body、cookie、session token。Route Handler は例外時も入力値をログへ出さない。ログへ出してよいのは route、status、duration、errorCode、requestId のみ。
- 保持期間・アクセス範囲: 本人のみ読み書き可。Admin による参照は T-403 で必要最小限を別途定義する。
- Threats and controls:
  - IDOR/BOLA → 対象指定手段がなく、actor ID を条件にした問い合わせのみ。Integration Test で他ユーザー行が不変であることを検証する。
  - 権限昇格 → 更新可能項目を 4 項目に限定し、未知キーは拒否(mass assignment 防止)。`status`、`email` 等は更新できない。
  - XSS(stored) → 表示名の制御文字・双方向制御文字を拒否。HTML として出力せず、出力時 escaping は React に委ねる。JSON 応答は `Content-Type: application/json`。
  - CSRF → session cookie は Auth.js 既定の `SameSite=Lax`。加えて `PATCH` は `Content-Type: application/json` を必須とし(単純リクエストを排除)、`Origin` ヘッダが存在し許可 Origin(`APP_BASE_URL`)と異なる場合は 403 とする。`Origin` ヘッダがない場合の扱い: ブラウザは `PATCH` で必ず付与するため、欠如は非ブラウザ client とみなして許可する(cookie を手で付与できる攻撃者は CSRF の前提を満たさない)。
  - Injection → Prisma のパラメータ化クエリのみを使用し、生 SQL を使わない。
  - DoS/abuse → body 4096 byte・各項目長の上限をパース前/Domain 前に適用。Intl 検証は 64 文字以内のみ実行する。rate limit は P2(具体閾値)未決であり、本タスクでは実装しない。認証必須・冪等・低コストの endpoint であるため残存リスクを許容する(Accepted Risks)。

## AI Requirements

N/A(本 Spec は AI を扱わない。AI へプロフィールを送らない方針のみ Security 節に記載)。

## Observability and Operations

- Logs: 構造化 JSON log の標準項目(route、method、status、duration、errorCode、requestId)のみ。user 識別が必要な場合は rotate 可能な pseudonymous ID を使い、生の user ID・表示名は出さない。
- Metrics: `/api/v1/me` の request count/error/latency(status 別)。timezone 検証失敗数は件数のみ(入力値を label に含めない)。
- Alerts: 専用 alarm は追加しない(既存の 5xx 比率 alarm に含まれる)。
- Runbook: 追加不要。障害時は 5xx 比率 alarm と DB 接続の既存 runbook に従う。
- Rollout/rollback: 新規 endpoint と DB 制約の追加のみ。Feature Flag 不要(未使用の endpoint であり、既存機能への影響がない)。rollback はアプリを前 revision へ戻す(DB 制約は後方互換のため残してよい)。deploy 順序は migration 先行、アプリ後続。

## Test Coverage Matrix

| Requirement          | Unit                                                                                          | Integration                                                         | E2E                       |
| -------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------- |
| PROF-001             | `getMyProfile`(既定作成・既存取得・user 不存在 → NotFound)、Route Handler の 200/401/404 変換 | `ensure` の遅延作成、並行 `ensure` で 1 行                          | 対象外(Playwright 未導入) |
| PROF-002             | `updateMyProfile`(partial update、同値、空更新拒否)、Route Handler の 422/413/415/403         | `update` が指定項目のみ更新し他項目・`updated_at` 以外を変更しない  | 対象外(Playwright 未導入) |
| PROF-003             | `parseDisplayName` 境界値(0/1/50/51、空白のみ、制御文字、bidi、サロゲートペア、NFC)           | DB CHECK(長さ 0・51 の直接 INSERT/UPDATE 拒否)                      | N/A                       |
| PROF-004             | `parseTimezone`(正規/別名/大文字小文字誤記/オフセット/略称/未知/長さ/DST 地域)                | DB CHECK(長さ)                                                      | N/A                       |
| PROF-005             | `isLocale`、`isWeekStartsOn`(0/6/-1/7/小数/文字列)                                            | DB CHECK(`week_starts_on`、`locale`)                                | N/A                       |
| PROF-006             | `createDefaultProfile` の値                                                                   | 遅延作成された行の既定値                                            | N/A                       |
| PROF-007             | 所有権 policy(他ユーザー行 → NotFound)、session→actor 変換(session なし/user なし → 401)      | user A の `update` が user B の行を変更しない、user 不存在で `null` | N/A                       |
| PROF-INV-001         | N/A                                                                                           | 並行 `ensure` で 1 行のみ                                           | N/A                       |
| PROF-INV-002/003/004 | 検証関数の網羅                                                                                | DB CHECK 違反                                                       | N/A                       |

契約(zod schema)の Unit Test も `packages/contracts` に追加する。外部サービスは使用しないため Fake は `ProfileRepositoryPort` のインメモリ実装のみ。fixture は架空データのみ(`example.com` の架空 email、架空の表示名)。

## Open Questions

実装を左右する未決事項はない。次は P1 の未決を暫定既定値で置き、確定時に定数と本 Spec を更新する(コード変更は定数のみ)。

- **週の開始曜日の既定値**(P1): 暫定で月曜(1)。
- **ロケール対応範囲**(P1): 暫定で `ja`/`en`。DB CHECK を持つため、言語追加には migration が必要。
- **既定タイムゾーン**: 暫定で `Asia/Tokyo`。オンボーディングで必ず明示設定させる UI 方針(T-101 後の画面実装)で補完する。

## Implementation Readiness

Status: Ready
Reviewed at: 2026-10-02
Reviewed by: —

| Gate                 | Result | Evidence                                                                                                                                                                                           |
| -------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product              | Pass   | Goal、Scope/Out of Scope、Success Metrics。[01-product-requirements.md](../01-product-requirements.md) 機能要件 2、UC-03、[09-roadmap.md](../09-roadmap.md) T-102                                  |
| Specification        | Pass   | PROF-001〜007、PROF-INV-001〜004、Acceptance Criteria、Failure and Edge Cases。未決は P1 の暫定既定値のみで実装を左右しない(Open Questions)                                                        |
| Domain and Time      | Pass   | timezone は IANA ID(PROF-004)。DST に依存する計算は行わない(保存のみ)。timezone 変更は過去の habit_date に影響しない(Business Rules)。同時更新は項目単位 last-write-wins と判断、冪等性は PROF-002 |
| API and Data         | Pass   | API and Events 節(入力/出力/status/上限)、Data and Migration 節(expand migration、CHECK、遅延作成、rollback)。OpenAPI 基盤未導入は Out of Scope に明記                                             |
| Security and Privacy | Pass   | Security and Privacy 節(収集データ、ログ禁止、IDOR/CSRF/XSS/mass assignment、入力上限)。rate limit 未実装は Accepted Risks                                                                         |
| AI                   | N/A    | AI を利用しないため                                                                                                                                                                                |
| Testing              | Pass   | Test Coverage Matrix。E2E は Playwright 未導入のため対象外と明記し、Integration/Route Handler 単体テストで代替                                                                                     |
| Operations           | Pass   | Observability and Operations 節(log 禁止項目、metrics、rollout/rollback、Feature Flag 不要の判断)                                                                                                  |
| Planning             | Pass   | [../plans/user-profile.md](../plans/user-profile.md)                                                                                                                                               |

### Accepted Risks

- `/api/v1/me` に rate limit を実装しない(P2 閾値未決、認証必須・冪等・低コスト)。rate limit 基盤導入時に適用する。
- E2E(onboarding profile)は Playwright 導入後に追加する。それまでは Route Handler 単体テストと Repository Integration Test で代替する。
- 楽観ロックを導入せず項目単位 last-write-wins とする(Business Rules 参照)。
- timezone の受理可否は実行環境の ICU/Node バージョンに依存する。Node のメジャー更新(`.nvmrc`)時は `parseTimezone` の Unit Test で差分を検知する。極端に新しい IANA ID は古い ICU で拒否されうる。
- `Origin` ヘッダ欠如を許可する(非ブラウザ client)。

### Open Questions

なし(上記 P1 暫定既定値は Open Questions 節で管理)
