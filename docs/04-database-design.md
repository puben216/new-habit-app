# 4. DB 設計案

## 方針

- PostgreSQL 16 以降を想定し、RDS のサポート対象版は実装時に固定する。
- 内部 PK は `bigint generated always as identity`。外部公開 ID は推測困難な `public_id uuid` を別途持つ。
- 文字列は原則 `text`、日時は `timestamptz`、ローカル習慣日は `date`、状態値は `text + CHECK`。
- すべての FK 列へアクセスパターンに合う index を付ける。主な一覧は cursor pagination。
- `created_at`, `updated_at` を持ち、重要な状態変更は監査ログへ記録する。
- アプリケーション用 DB role に schema 所有権や DDL 権限を与えず、migration role を分離する。

## ER 概要

```text
users 1--1 user_profiles
users 1--N habits 1--N habit_schedule_versions
users 1--N habit_entries N--1 habits
users 1--N daily_check_ins
users 1--N weekly_reviews 1--N coaching_suggestions
users 1--N ai_jobs 1--N ai_job_attempts
users 1--N notification_settings 1--N notification_deliveries
users 1--N idempotency_keys
admins/users 1--N audit_logs
```

## テーブル案

### `users`

| 列                    | 型              | 制約・用途                                    |
| --------------------- | --------------- | --------------------------------------------- |
| id                    | bigint identity | PK                                            |
| public_id             | uuid            | UNIQUE、外部 ID                               |
| auth_subject          | text            | UNIQUE、IdP の不変 subject                    |
| email_normalized      | text            | UNIQUE、暗号化/保持方針は認証方式決定後に確定 |
| status                | text            | CHECK: active, suspended, deletion_pending    |
| deleted_at            | timestamptz     | nullable                                      |
| created_at/updated_at | timestamptz     | NOT NULL                                      |

### `user_profiles`

`user_id` PK/FK、`display_name`、`timezone`、`locale`、`week_starts_on`、timestamps。タイムゾーンは IANA ID としてアプリ側 allowlist でも検証する。

### `habits`

`id`, `public_id`, `user_id`, `kind` (`build|reduce`), `name`, `purpose`, `cue`, `minimum_action`, `replacement_action`, `status` (`active|archived`), `version`, timestamps。`reduce` では `replacement_action` を推奨するが必須にはしない。

Index:

- `(user_id, status, created_at desc, id desc)`
- `UNIQUE (user_id, public_id)`（または public_id 単独 UNIQUE）

### `habit_schedule_versions`

`id`, `habit_id`, `effective_from date`, `effective_to date nullable`, `days_of_week smallint[]`, `local_time time nullable`, `target_count smallint default 1`, timestamps。`target_count` は `build` 習慣の 1 日の目標実施回数（複数可）。`reduce` 習慣は MVP では常に 1 に固定する。

制約:

- 曜日は 0〜6、配列は空でない、target_count > 0
- `reduce` 習慣の habit に紐づく行は `target_count = 1`（アプリ側 constraint、必要なら CHECK/trigger で二重に強制）
- `(habit_id, effective_from)` UNIQUE
- 同一習慣の有効期間重複は exclusion constraint、またはトランザクション内検査で禁止
- `habit_id` index

### `habit_entries`

`id`, `public_id`, `user_id`, `habit_id`, `habit_date date`, `scheduled_for timestamptz nullable`, `status` (`success|missed|skipped`), `quantity numeric nullable`, `note text nullable`, `source` (`web|system`), timestamps。`quantity` は `build` の当日実施回数を表し、対応する schedule version の `target_count` 以上で `status = success` とする。`reduce` は `target_count = 1` のため quantity は使用しないか常に 0/1 とする。

制約・Index:

- `UNIQUE (habit_id, habit_date)`（1 習慣 1 日 1 レコード。`build` の複数回実施は 1 レコード内の quantity で表現し、予定機会を複数レコードには分割しない）
- `(user_id, habit_date desc, id desc)`
- `(habit_id, habit_date desc)`
- note はアプリ側と DB 制約で上限を設ける

`user_id` は所有権確認とユーザー単位 query のため意図的に重複保持し、habit 所有者との整合性は composite FK またはトランザクション内で保証する。

### `daily_check_ins`

`id`, `user_id`, `check_in_date date`, `mood smallint nullable`, `difficulty smallint nullable`, `note text nullable`, timestamps。`UNIQUE(user_id, check_in_date)`、値域は 1〜5。

### `weekly_reviews`

`id`, `public_id`, `user_id`, `week_start date`, `timezone_snapshot`, `summary_json jsonb`, `reflection text`, `status` (`draft|completed`), `completed_at`, timestamps。`UNIQUE(user_id, week_start)`。

`summary_json` は再現可能な入力値と schema version を持つスナップショット。検索対象の基本属性は列として保持し、JSONB に閉じ込めない。

### `ai_jobs` / `ai_job_attempts`

`ai_jobs`: `id`, `public_id`, `user_id`, `kind`, `subject_type`, `subject_public_id`, `status` (`queued|running|succeeded|failed|fallback`), `prompt_version`, `output_schema_version`, `provider`, `model`, `input_fingerprint`, `result_json jsonb nullable`, `failure_code nullable`, timestamps。

`ai_job_attempts`: `id`, `ai_job_id`, `attempt_no`, `provider_request_id nullable`, `started_at`, `finished_at`, `outcome`, `latency_ms`, `input_tokens`, `output_tokens`, `estimated_cost nullable`, `error_category nullable`。

生のプロンプト、自由記述、モデル応答は通常ログに出さない。保存が必要な場合は暗号化、保持期限、アクセス制御を別途定義する。

### 通知・運用

- `notification_settings`: user/habit、channel、local_time、enabled、timezone、quiet hours
- `notification_deliveries`: deduplication_key UNIQUE、scheduled_at、status、provider_message_id、attempt_count、sent_at、failure_code
- `idempotency_keys`: `(user_id, scope, key)` UNIQUE、request_hash、response_code/body、expires_at
- `audit_logs`: actor、action、target_type、target_public_id、request_id、IP の不可逆化表現、created_at。追記専用

## 削除方針

- 習慣は通常アーカイブ。ユーザー削除は `deletion_pending` を経て非同期に子データを物理削除。
- FK の `ON DELETE` は意図を個別指定する。ユーザー配下の個人データは CASCADE 候補、監査ログは識別子を匿名化して保持。
- AI provider 側データの削除可否と保持期間も削除ワークフローに含める。

## Migration 方針

- 変更は必ず timestamp 付き migration。適用済み migration は編集しない。
- expand/contract を用い、列追加 → backfill → 読み替え → 制約強化 → 旧列削除を別 deploy に分ける。
- 大規模 index は `CREATE INDEX CONCURRENTLY` を検討し、transaction 非対応を migration tool で扱う。
- staging で本番相当データ量の migration 時間・lock を計測。down migration より forward fix と backup restore を重視。

## 集計定義

- 予定機会数: 対象期間と schedule version から生成した日数（`target_count` が複数でも 1 日 1 予定機会として数える）
- 成功率: `success / (scheduled - skipped)`。分母 0 は null。`build` の当日成功は `quantity >= target_count`
- 現在ストリーク: 直近の確定済み予定機会から遡った連続 success 数
- 最長ストリーク: 対象期間内の連続 success 最大値

これらは Domain の純粋関数を唯一の定義とし、SQL 集計を追加する場合も同じ契約テストを通す。

## 実装時の補足（T-004）

Prisma（[ADR-002](adr/ADR-002-orm.md)）で初期 migration を実装した際の、本設計からの実務上の差分・追加決定。schema/migration の正本は `packages/infrastructure/database/`。

- 内部 PK は Prisma の `autoincrement()`（`BIGSERIAL`）を採用した。`GENERATED ALWAYS AS IDENTITY` は Prisma の DSL で直接表現できず、hand-edit した migration の保守性を優先して見送った。アプリケーションからの見え方は同一。
- `habit_schedule_versions.days_of_week` は Prisma の型システムの制約により `smallint[]` ではなく `integer[]` とした。値域 0〜6 は CHECK 制約（`array_length > 0` かつ `<@ ARRAY[0..6]`）で担保する。
- 同一 `habit_id` のスケジュール有効期間重複は、`btree_gist` 拡張を用いた PostgreSQL の exclusion constraint（GiST）で DB レベルに強制した（本文の「exclusion constraint、またはトランザクション内検査」の前者を採用）。
- `reduce` 習慣の `target_count = 1` 固定は `habits.kind` を跨ぐ検証が必要なため、DB constraint/trigger ではなく Application 層（T-104）で検証する。
- `updated_at` は Prisma Client の `@updatedAt` に加え、DB 側にも `DEFAULT CURRENT_TIMESTAMP` と `BEFORE UPDATE` trigger を追加した。生 SQL や管理ツール経由の書き込みでも一貫させるため。
- `notification_settings` / `notification_deliveries` は本文の記述が簡潔なため、T-004 では実装者判断で最小限の列（`habit_id` は nullable、`channel` は `email` 既定など）とした。詳細は T-401 着手時に見直す。
- ER 概要にある `coaching_suggestions` はテーブル定義が未記載のため、本 baseline には含めていない。T-304/T-305 で設計する。
- `habit_entries.note` 等の自由記述の文字数上限は未決（[10-decisions-and-open-questions.md](10-decisions-and-open-questions.md) の P2 参照）のため、DB 側の CHECK は追加していない。
