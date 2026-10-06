# Notification Preferences Spec

Status: Ready
Owner: TBD
Last updated: 2026-10-04
Change classification: Standard
Roadmap Task: T-401

## Goal

ログイン済みのユーザーが、リマインドメールの受信可否(opt-in)・送信時刻・送信しない時間帯(quiet hours)・タイムゾーンを保存・変更・停止できるようにする(UC-14)。通知は既定で無効とし、ユーザーが明示的に有効化したときだけ後続の配送(T-402)の対象になる。本タスクは「設定の保存と停止」までを扱い、メール送信は行わない。

## Success Metrics

- `PUT /api/v1/notification-settings` が冪等な置換として動作し、同一内容の再送・並行送信でも 1 ユーザー 1 設定のまま、重複や 500 が起きない(Integration Test で確認)。
- 設定を保存していないユーザーは常に「無効」として扱われ、行を持たないまま `GET` が既定値を返す(opt-in が既定)。
- `enabled: false` の `PUT` だけで配信停止でき、以後 T-402 が参照する設定は無効になる。
- 時刻・quiet hours・timezone の検証を Domain の関数だけが判定し、Application/Presentation/Infrastructure で再実装していない。
- 他ユーザーの設定は取得も更新もできず、path/body にユーザーを指定する余地がない。

## Scope

- Domain(notifications): `resolveNotificationPreference`(送信時刻 `HH:mm`、quiet hours、timezone の検証と既定値の適用)、`isWithinQuietHours`(T-402 が再利用する純粋関数)、`InvalidNotificationPreferenceError`。
- Application: `getNotificationSettingsUseCase`、`upsertNotificationSettingsUseCase`、`NotificationSettingsRepositoryPort`、Application error。
- Infrastructure: `PrismaNotificationSettingsRepository`(`notification_settings` の冪等 upsert と取得)。
- DB: Migration 1 本(制約・一意 index の追加。expand のみ)。
- Contracts: request/response の runtime schema(zod、`.strict()`)。
- Presentation(`apps/web`): `GET/PUT /api/v1/notification-settings`。
- 文書: `docs/04`、`docs/05`、`docs/09`、`docs/10`(P2 の暫定 quiet hours)。

## Out of Scope

- メール送信、送信予定の生成、dedupe、bounce/complaint、SES 設定(T-402。[ADR-005](../adr/ADR-005-email.md))。
- メール本文中の署名付きワンクリック unsubscribe リンク、トークン生成・検証、公開 endpoint(T-402 で送信と同時に設計する)。本タスクの停止経路はログイン後の設定 OFF のみ。
- 習慣ごとの通知設定(`habit_id` 付きの行)と `habit_schedule_versions.local_time` / `localTime` の API 対応。本タスクは `habit_id IS NULL`(ユーザー単位)の行だけを扱う。
- Push/SMS 等のメール以外の channel(D-09)。`channel` は `email` 固定。
- 通知設定画面(UI)、Playwright E2E(基盤未導入)、Rate limit(P2 未決)。
- プロフィールの timezone 変更に連動した通知 timezone の自動更新(Open Questions)。

## Actors and Preconditions

| Actor                  | Preconditions                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------- |
| Guest(未認証)          | なし。すべての endpoint で `401`                                                      |
| Member(email 確認済み) | T-101 の session を持つ。timezone の既定値は T-102 のプロフィール(未作成なら遅延作成) |

actor の user ID は session のみから取得し、request の body/query/path/header から受け取らない。

## Functional Requirements

### NPF-001 設定の取得

- `GET /api/v1/notification-settings` は actor 自身の通知設定を `200` で返す。
- 設定が未保存の場合も `200` で既定値を返す: `enabled: false`、`localTime: "20:00"`、`timezone` はプロフィールの timezone、`quietHours: { start: "22:00", end: "07:00" }`、`updatedAt: null`。DB には書かない(GET は副作用を持たない。ただしプロフィールの遅延作成は T-102 の既存挙動)。

### NPF-002 設定の保存(冪等な置換)

- `PUT /api/v1/notification-settings` は body `{ enabled, localTime, quietHours?, timezone? }` を受け取り、`200` と保存後の設定を返す。
- `enabled` と `localTime` は必須。`quietHours` を省略すると既定の `22:00`〜`07:00`、`null` を明示すると quiet hours なし、`timezone` を省略するとプロフィールの timezone が適用される。
- `PUT` は設定全体の置き換えである(部分更新ではない)。同じ内容の再送は同じ内容を返し、並行 `PUT` はすべて成功し後勝ちで 1 行に収束する。
- `enabled: true` がオプトイン、`enabled: false` が配信停止(NPF-004)。無効でも `localTime` 等は保存する(再度有効にしたときに入力し直さなくてよい)。

### NPF-003 内容の検証(Domain)

`resolveNotificationPreference(input)` は次を満たす内容を返し、満たさなければ `InvalidNotificationPreferenceError` を投げる。

- `localTime`: `HH:mm`(24 時間、`00:00`〜`23:59`、分単位)。秒は受け付けない。
- `timezone`: Domain の `parseTimezone`(T-102、IANA ID)で検証する。
- `quietHours`: `{ start, end }`(各 `HH:mm`)または `null`。`start === end` は拒否する(全日が quiet になる/意味が曖昧なため)。`start > end` は日跨ぎ(例 `22:00`〜`07:00`)を表す。区間は `[start, end)`(開始時刻を含み、終了時刻を含まない)。
- `enabled: true` のとき、`localTime` が quiet hours に含まれる設定は拒否する(その時刻の通知が常に送られない矛盾した設定を防ぐ)。`enabled: false` のときはこの組み合わせ検査を行わない(停止は常に保存できる)。

### NPF-004 配信停止

- `enabled: false` の `PUT` が配信停止である。以後 T-402 は `enabled = true` の設定だけを走査対象にする。
- 停止は即時に有効で、`PUT` の成功後に再有効化されない(再有効化はユーザーの明示的な `enabled: true` のみ)。
- アカウント削除(T-404)では `ON DELETE CASCADE` により設定も削除される。

## Business Rules and Invariants

- NPF-INV-001(所有者限定): すべての repository 操作は actor user ID を条件に含む。API に他ユーザーを指定する手段がない。
- NPF-INV-002(一意性): 1 ユーザーにつきユーザー単位の設定(`habit_id IS NULL`)は高々 1 行(部分 unique index `notification_settings_user_default_uidx`)。upsert は `INSERT ... ON CONFLICT (user_id) WHERE habit_id IS NULL DO UPDATE` の単一文で行う。
- NPF-INV-003(opt-in 既定): 行がない、または `enabled = false` のユーザーには通知しない。`enabled` の既定値は常に `false`(DB 既定の `true` は本 API 経由では使わず、upsert で明示する)。
- NPF-INV-004(channel): `channel = 'email'` 固定(DB CHECK)。
- NPF-INV-005(quiet hours の整合): `quiet_hours_start` と `quiet_hours_end` は両方 NULL か両方非 NULL(DB CHECK)。`start <> end`(DB CHECK)。
- NPF-INV-006(時刻の解釈): `local_time`・quiet hours は `timezone` のローカル時刻として解釈する。保存値は UTC に変換しない(DST で意味が変わらないようにするため。実際の送信時刻の計算と DST の存在しない/重複時刻の解決は T-402)。
- NPF-INV-007(既定値の定数): 既定の送信時刻 `20:00` と既定の quiet hours `22:00`〜`07:00` は Domain の定数 1 箇所のみで定義する。いずれも `docs/10` P2 が確定するまでの暫定値で、確定後は定数のみ変更する(DB には焼き込まない)。

## State Transitions

| Current         | Action                          | Next               | Rejected when                                                 |
| --------------- | ------------------------------- | ------------------ | ------------------------------------------------------------- |
| (行なし = 無効) | PUT `enabled: true`(有効な内容) | 有効(新規作成)     | 時刻・timezone・quiet hours が不正、送信時刻が quiet hours 内 |
| (行なし = 無効) | PUT `enabled: false`            | 無効(行を作成)     | 時刻・timezone・quiet hours の形式が不正                      |
| 有効            | PUT `enabled: true`(有効な内容) | 有効(全項目を置換) | 同上                                                          |
| 有効            | PUT `enabled: false`            | 無効(配信停止)     | 形式が不正                                                    |
| 無効            | PUT `enabled: true`(有効な内容) | 有効               | 同上                                                          |

行の削除はない。

## Acceptance Criteria

```gherkin
Scenario: 未保存のユーザーは無効として既定値を得る
  Given 設定を保存していないユーザー、timezone が Asia/Tokyo
  When GET /notification-settings を呼ぶ
  Then 200 で enabled=false、localTime="20:00"、timezone="Asia/Tokyo"、quietHours が 22:00〜07:00、updatedAt=null
  And notification_settings に行は作られない

Scenario: opt-in して取得する
  When PUT に {enabled: true, localTime: "07:30"} を送る
  Then 200 で enabled=true、localTime="07:30"、timezone=プロフィールの timezone、quietHours=22:00〜07:00 が返る
  And GET で同じ内容が取得できる

Scenario: 置換と再送
  Given enabled=true, localTime="07:30" の設定
  When {enabled: true, localTime: "21:00", quietHours: null} を PUT する
  Then quietHours は null になり、行は 1 件のまま
  And 同じ内容の再送は同じ内容を返す

Scenario: 配信停止
  Given enabled=true の設定
  When {enabled: false, localTime: "07:30"} を PUT する
  Then 200 で enabled=false、行は残り localTime は保持される

Scenario: 送信時刻が quiet hours 内
  When {enabled: true, localTime: "23:00"}(quiet は既定の 22:00〜07:00)を PUT する
  Then 422(code: reminder_time_in_quiet_hours)で保存されない
  And {enabled: false, localTime: "23:00"} は 200

Scenario: quiet hours の境界
  Given quiet hours が 22:00〜07:00
  Then isWithinQuietHours は 22:00 と 06:59 と 00:00 で true、07:00 と 21:59 で false
  And quiet hours が 01:00〜05:00(日跨ぎなし)のとき 01:00 は true、05:00 は false

Scenario: 不正な入力
  When localTime="24:00"、"7:30"、"07:30:00"、quietHours の start=end、timezone="JST" を送る
  Then すべて 422 で何も保存されない

Scenario: timezone を指定する
  When {enabled: true, localTime: "08:00", timezone: "America/New_York"} を PUT する
  Then timezone=America/New_York が保存され、プロフィールの timezone は変わらない

Scenario: 他ユーザーの設定は見えない
  Given ユーザー A が enabled=true の設定を保存している
  When ユーザー B が GET を呼ぶ
  Then B には B 自身の設定(未保存なら既定値・無効)が返り、A の内容は含まれない

Scenario: 並行送信
  When 同じユーザーが PUT を 2 件以上同時に実行する
  Then すべて 200 で、行は 1 件
```

## Authorization Matrix

| Operation                  | Guest | Member(自分) |           Member(他人) |
| -------------------------- | ----: | -----------: | ---------------------: |
| GET /notification-settings |   401 |          Yes | 到達不可(自分の分のみ) |
| PUT /notification-settings |   401 |          Yes | 到達不可(自分の分のみ) |

path にユーザーを含めないため IDOR の経路がない。Admin は対象外(T-403 の read-only 運用画面は別 Spec)。

## API and Events

共通: base path `/api/v1`、JSON、未知キー拒否、Problem Details、`Cache-Control: no-store`。`PUT` は `Content-Type: application/json` 必須(`415`)、body 上限 16 KiB(`413`)、Origin 検証(`403 invalid_origin`)。T-104/T-202/T-203 と同じ共通処理を再利用する。Events は発行しない。

| Method/Path                  | 入力                                                     | 成功 | エラー                       |
| ---------------------------- | -------------------------------------------------------- | ---- | ---------------------------- |
| `GET /notification-settings` | なし                                                     | 200  | 401, 404                     |
| `PUT /notification-settings` | body: `enabled`, `localTime`, `quietHours?`, `timezone?` | 200  | 401, 403, 404, 413, 415, 422 |

### Resource: NotificationSettings

```json
{
  "enabled": true,
  "localTime": "07:30",
  "timezone": "Asia/Tokyo",
  "quietHours": { "start": "22:00", "end": "07:00" },
  "updatedAt": "2026-10-04T03:00:00.000Z"
}
```

- 内部 PK、`user_id`、`habit_id`、`channel` は応答に含めない。`quietHours` なしは `null`。未保存の既定値は `updatedAt: null`。
- 422 の `code`: `validation_failed`(schema 違反。`fieldErrors` に項目)、`invalid_notification_setting`(Domain の内容違反。timezone・quiet hours の値など)、`reminder_time_in_quiet_hours`(`enabled: true` で送信時刻が quiet hours 内)。
- `404` は `user_not_found`(session の user が存在しない)のみ。
- `Idempotency-Key` は使わない(PUT が自然に冪等な置換のため)。

## Data and Migration

- 既存の `notification_settings`(T-004)を使う。Migration `t401_notification_settings_constraints`(expand のみ。後方互換):
  - `CREATE UNIQUE INDEX notification_settings_user_default_uidx ON notification_settings (user_id) WHERE habit_id IS NULL`(NPF-INV-002。ユーザー単位の設定の一意性と upsert の arbiter)。
  - `CHECK (channel = 'email')`、`CHECK ((quiet_hours_start IS NULL) = (quiet_hours_end IS NULL))`、`CHECK (quiet_hours_start IS NULL OR quiet_hours_start <> quiet_hours_end)`、`CHECK (char_length(timezone) BETWEEN 1 AND 64)`(`user_profiles` と同じ)。
- 既存行: T-004 以降アプリは `notification_settings` に書き込んでおらず既存行がない前提のため backfill は不要。万一ある環境でも unique index の作成に失敗して Migration が止まるだけで、データは変更されない。
- FK `user_id` の index: 既存 `notification_settings_user_id_idx` と上記の部分 unique index が `WHERE user_id = ?` に使える。FK `habit_id` の既存 index は変更しない。`notification_deliveries.notification_setting_id` の index は既存。
- `local_time`・quiet hours は `time`(タイムゾーンなし)、`timezone` は IANA ID(`text`)。`enabled` は常に明示して書く。`created_at` は新規作成時のみ Clock の値、更新時の `updated_at` は既存の `set_updated_at` trigger が決める(T-202/T-203 と同じ)。
- アクセスパターン: `WHERE user_id = ? AND habit_id IS NULL`(部分 unique index に一致)。T-402 の走査用 index は T-402 で追加する。
- rollback: Migration は index と CHECK の追加のみ。アプリを revert すれば足り、必要ならこれらを DROP する forward Migration を追加する(適用済み Migration は編集しない)。

## Failure and Edge Cases

- `localTime` の形式違い(`7:30`、`07:30:00`、`24:00`、`07:60`)→ 422 `validation_failed`(`fieldErrors.localTime`)。
- `quietHours.start === end` → 422 `invalid_notification_setting`。形式違い → 422 `validation_failed`。
- `timezone` が不正(`JST`、`+09:00`、未知の ID)→ 422 `invalid_notification_setting`(`fieldErrors.timezone`)。
- `enabled: true` かつ送信時刻が quiet hours 内 → 422 `reminder_time_in_quiet_hours`。
- `enabled` が真偽値でない、`localTime` 欠落 → 422 `validation_failed`。
- 未知キー(`userId`、`habitId`、`channel` など)→ 422 `validation_failed`。
- プロフィールの timezone を変更した後: 保存済みの通知 timezone は変わらない。通知 timezone を変えるには `PUT` で明示する(Open Questions)。
- session の user が削除済み → 404 `user_not_found`。
- DB 制約違反(Domain/契約をすり抜けた場合)→ 内部エラー(500)。内部詳細は応答に含めない。

## Security and Privacy

- Data collected: 通知の可否・時刻・quiet hours・timezone(個人の生活リズムを推測しうる個人データ)。user ID は actor 取得のみに使用し外部送信しない。外部 provider(AI を含む)への送信なし。メールアドレスは本 API で扱わない(送信先は T-402 が認証済みの user から取得する)。
- 保持/アクセス: 本人のみ参照・更新可。削除は T-404 のユーザー削除フロー(`ON DELETE CASCADE`)に従う。
- Data forbidden in logs: request body、設定値、session、cookie、email。route に独自ログを追加しない。エラー応答に stack・SQL・DB エラー内容を含めない。
- IDOR/BOLA: NPF-INV-001(path に user を持たない)。CSRF: Origin 検証 + `Content-Type: application/json`。XSS: JSON のみを返し、自由記述の入力項目がない。Injection: `$queryRaw` のタグ付きテンプレート(バインド変数のみ)。権限昇格: Admin 経路なし。
- Abuse: body 16 KiB、項目はすべて固定形式で上限が小さい。通知の濫用(他人宛の送信)は、送信先を設定から指定できない設計(email は user から取得)で防ぐ。Rate limit は Out of Scope(Accepted Risks)。
- opt-in の同意: 既定は無効。サーバーはユーザーの明示的な `enabled: true` 以外で有効化しない。

## AI Requirements

N/A。AI を利用しない。

## Observability and Operations

- Logs: route に独自ログを追加しない(構造化ログ基盤が未導入)。設定値・body を記録しない。
- Metrics/Alerts: 既存方針(`docs/06`)の request count/error/latency に含まれる。専用 metric/alarm は追加しない。通知 delivery の metric は T-402。
- Runbook: 不要。
- Rollout/rollback: Feature Flag なし(新規 route のみ。有効化してもメールは送信されない)。Migration は expand のみ。rollback はアプリの revert。
- 費用・capacity: メール送信を行わないため影響なし。

## Test Coverage Matrix

| Requirement | Unit                                                                                                                    | Integration(実 PostgreSQL)                                                 | E2E                       |
| ----------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------- |
| NPF-001     | `getNotificationSettingsUseCase`(未保存の既定値・保存済み・プロフィール timezone)、handler の 200/401                   | 未保存で行が作られない、保存→取得の往復                                    | N/A(E2E 基盤導入後に追加) |
| NPF-002     | `upsertNotificationSettingsUseCase`(fake: 作成/置換/再送/既定値の適用)、handler の 200/401/403/413/415/422              | upsert の作成→更新、置換、再送、並行 6 件で 1 行                           | N/A                       |
| NPF-003     | `resolveNotificationPreference`(時刻境界、timezone、start=end、日跨ぎ、enabled の有無による組み合わせ検査)、契約 schema | DB の CHECK(channel、quiet hours の片方 NULL、start=end、timezone 長)      | N/A                       |
| NPF-004     | `upsert` で `enabled: false` が保存され localTime が保持される                                                          | 有効→無効→有効の往復                                                       | N/A                       |
| NPF-INV-001 | repository 呼び出しに actor が必ず渡ることを fake で検証、handler が body の user 指定を拒否                            | 他ユーザーの設定と混ざらない                                               | N/A                       |
| NPF-INV-002 | -                                                                                                                       | 部分 unique index と ON CONFLICT、`habit_id` 付きの行とは別枠、並行 upsert | N/A                       |
| NPF-INV-006 | `isWithinQuietHours`(22:00/06:59/00:00/07:00/21:59、日跨ぎなし)                                                         | -                                                                          | N/A                       |

Migration の検証: fresh database への適用と、既存 schema(直前の Migration まで適用済み)からの upgrade の両方を Integration Test で確認する。Fake/Stub 方針: Application の unit test は in-memory fake、固定 Clock、プロフィールは既存の fake。Integration は Testcontainers の実 PostgreSQL。fixture は架空データのみ。

## Open Questions

実装をブロックしない事項:

- **既定の送信時刻 `20:00` と quiet hours `22:00`〜`07:00`**: `docs/10` P2 が未決のため暫定値(ユーザー確認済み)。確定後に Domain の定数のみ更新する。
- **プロフィール timezone 変更との連動**: 現状は連動しない(通知 timezone は明示的に保持)。利用実態を見て、プロフィール変更時に追随させるか T-402 以降で判断する。
- **メール内ワンクリック unsubscribe**: T-402(送信実装)で署名付きリンクとして設計する。
- **習慣ごとの通知・`localTime`**: 要望と T-402 の設計を見て別タスクで検討する。
- **SES 送信ドメイン**: [ADR-005](../adr/ADR-005-email.md) のとおり T-402 着手前までに確定する。本タスクはブロックされない。

## Implementation Readiness

Status: Ready
Reviewed at: 2026-10-04
Reviewed by: —

| Gate                 | Result | Evidence                                                                                                                      |
| -------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Product              | Pass   | Goal、Success Metrics、Scope/Out of Scope。`docs/02` UC-14、`docs/09` T-401                                                   |
| Specification        | Pass   | NPF-001〜004、NPF-INV-001〜007、State Transitions、Acceptance Criteria、Failure and Edge Cases。未決事項は非ブロック          |
| Domain and Time      | Pass   | 時刻の解釈(ローカル時刻 + IANA timezone、UTC 変換しない)、日跨ぎ quiet hours、DST は T-402 と明記。冪等性・並行は ON CONFLICT |
| API and Data         | Pass   | API and Events、Data and Migration(expand のみ、制約・index、既存行、fresh/upgrade 検証、rollback)                            |
| Security and Privacy | Pass   | Security and Privacy、Authorization Matrix(IDOR/CSRF/XSS/Injection/abuse、ログ禁止、opt-in 既定、AI へ送らない)               |
| AI                   | N/A    | AI を利用しない                                                                                                               |
| Testing              | Pass   | Test Coverage Matrix。E2E は基盤未導入のため N/A と理由を明記                                                                 |
| Operations           | Pass   | Observability and Operations(ログ方針、rollout/rollback、メール未送信のため費用影響なし)                                      |
| Planning             | Pass   | [../plans/notification-preferences.md](../plans/notification-preferences.md)                                                  |

### Accepted Risks

- Rate limit 未実装(T-104/T-202/T-203 と同じ)。入力は固定形式で body 16 KiB に制限する。
- `PUT` は後勝ち。古い画面からの保存が別端末の設定を上書きしうる(単純さを優先して楽観ロックは導入しない)。
- 本タスクではメール内 unsubscribe リンクがない。ただしメールを送る T-402 より前なので、配信停止の経路が存在しない状態でメールが送られることはない(T-402 の Start Condition とする)。
- 暫定の既定値(送信時刻・quiet hours)は P2 確定時に変わりうる。既存ユーザーが保存済みの値は変更しない。
- 構造化ログ未導入のため、本 API 固有の運用ログ/metric は追加しない。
