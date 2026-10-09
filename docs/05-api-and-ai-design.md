# 5. API・AI 設計案

## API 原則

- JSON REST API、base path `/api/v1`
- 認証 cookie は `HttpOnly`, `Secure`, `SameSite=Lax` を基本とし、状態変更へ CSRF 対策
- すべての入力を runtime schema で検証し、未知キーは原則拒否
- リソースの外部 ID は UUID。所有権不一致も 404 とし存在を漏らさない
- 更新は `version` または ETag/`If-Match` で楽観ロック
- POST の重要操作は `Idempotency-Key` 対応
- 一覧は `limit` + opaque cursor、最大件数を制限
- エラーは Problem Details 形式を参考に `code`, `message`, `fieldErrors`, `requestId` を返す。内部詳細は返さない

## エンドポイント案

### Session/Profile

| Method    | Path         | 用途                                                     |
| --------- | ------------ | -------------------------------------------------------- |
| POST      | `/auth/*`    | IdP Adapter 経由の登録・ログイン等（方式確定後に詳細化） |
| GET/PATCH | `/me`        | 自分のプロフィール取得・更新                             |
| DELETE    | `/me`        | 再認証を伴う削除要求                                     |
| GET       | `/me/export` | 非同期 export ジョブ作成または取得                       |

### Habits/Tracking

| Method    | Path                               | 用途                    |
| --------- | ---------------------------------- | ----------------------- |
| GET/POST  | `/habits`                          | 一覧・作成              |
| GET/PATCH | `/habits/{habitId}`                | 詳細・更新              |
| POST      | `/habits/{habitId}/archive`        | アーカイブ              |
| GET       | `/schedule/today`                  | 当日の予定機会          |
| PUT       | `/habits/{habitId}/entries/{date}` | 記録の冪等作成・訂正    |
| GET       | `/habit-entries`                   | 期間・habit 指定の履歴  |
| PUT       | `/daily-check-ins/{date}`          | 日次チェックイン upsert |
| GET       | `/dashboard?from=&to=`             | ストリーク・継続率      |

### Reviews/Coaching

| Method    | Path                                  | 用途                         |
| --------- | ------------------------------------- | ---------------------------- |
| GET/POST  | `/weekly-reviews`                     | 一覧・対象週の作成           |
| GET/PATCH | `/weekly-reviews/{reviewId}`          | 詳細・確定                   |
| POST      | `/coaching/habit-designs`             | AI 設計ジョブを作成（202）   |
| POST      | `/weekly-reviews/{reviewId}/analysis` | AI 分析ジョブを作成（202）   |
| GET       | `/ai-jobs/{jobId}`                    | status/result/failure を取得 |
| POST      | `/coaching-suggestions/{id}/apply`    | 選択内容を検証して反映       |

### Notifications/Admin

| Method  | Path                              | 用途                 |
| ------- | --------------------------------- | -------------------- |
| GET/PUT | `/notification-settings`          | 本人の通知設定       |
| GET     | `/admin/operations/ai-jobs`       | 管理者の失敗状況確認 |
| GET     | `/admin/operations/notifications` | 配送失敗確認         |
| GET     | `/admin/users/{publicId}`         | 必要最小限の状態確認 |

## HTTP 契約例

習慣作成:

```json
{
  "kind": "build",
  "name": "朝に本を読む",
  "purpose": "学習を日常化する",
  "cue": "朝食後",
  "minimumAction": "1ページ読む",
  "schedule": {
    "daysOfWeek": [1, 2, 3, 4, 5],
    "localTime": "07:30",
    "targetCount": 1
  }
}
```

`targetCount` は `build` のみ 2 以上を許可する（`reduce` は常に 1）。成功時は `201` とリソース、validation は `422`、未認証 `401`、所有権を含む非存在 `404`、version 競合 `409`、rate limit `429`。

### T-104 で確定した Habit API の契約差分

`/habits` 系の正式な契約は [../specs/habit-api.md](specs/habit-api.md) の APIとイベント節と `packages/contracts/src/habits.ts` を正本とし、上記の例からの差分は次のとおり。

- `schedule.effectiveFrom`（`YYYY-MM-DD`）を必須とする（サーバーがユーザーのローカル日付を推測しない）。`schedule.localTime` は受け付けない（習慣ごとの通知時刻は T-401 の対象外で、別タスクで扱う）。
- 楽観ロックの `version` は `If-Match` ではなく PATCH/archive の request body で受け取る。不一致は `409`（`version_conflict`）、アーカイブ済みの更新は `409`（`habit_archived`）。
- `GET /habits` は `status`（`active|archived`、既定 `active`）、`limit`（1〜100、既定 20）、`cursor` を受け付け、`{ items, nextCursor }` を返す。
- 状態変更メソッドは `Origin` 検証と `Content-Type: application/json` を必須とする。`Idempotency-Key` と rate limit は未対応。

`PUT /habits/{habitId}/entries/{date}` は `status` に加えて `quantity`（当日の実施回数、`build` の target_count が複数の場合に使用）を受け付ける。

`/schedule/today` と `/habits/{habitId}/entries/{date}` の正式な契約は [../specs/habit-entry.md](specs/habit-entry.md) の APIとイベント節と `packages/contracts/src/tracking.ts` を正本とし、上記の例からの差分は次のとおり。

- `GET /schedule/today` は actor の timezone のローカル日に予定された active な習慣と当日の記録を `{ date, timezone, items }` で返す。クライアントは `date` を `PUT` の日付に使う。
- `PUT` の body は `{ status, quantity? }`。`note` は受け付けない（文字数上限が P2 で未決のため）。`build` の `success` は `quantity >= target_count`（省略時は target_count）、`missed` は `quantity < target_count`（省略時は 0）、`skipped` と `reduce` は `quantity` を指定できない。`reduce` は `status` のみで成否を表す。
- 対象日は actor の「今日」から過去 7 日まで。範囲外は `422`（`entry_date_out_of_range`）、予定のない日は `422`（`habit_not_scheduled`）、内容の不整合は `422`（`invalid_habit_entry`）、アーカイブ済みの習慣は `409`（`habit_archived`）。
- `PUT` は `(habit, date)` の自然キーで冪等であり、`Idempotency-Key` は使わない。同じ日への並行送信は後勝ちで 1 レコードに収束する。成功は常に `200`。
- 状態変更の共通要件（`Origin` 検証、`Content-Type: application/json`、body 上限）は `/habits` と同じ。rate limit は未対応。
- `GET /habit-entries`（履歴）は T-202 の対象外。

`/daily-check-ins/{date}` の正式な契約は [../specs/daily-check-in.md](specs/daily-check-in.md) の APIとイベント節と `packages/contracts/src/check-in.ts` を正本とし、上記の例からの差分は次のとおり。

- `GET /daily-check-ins/{date}` を追加する（自分のその日のチェックインを返す。なければ `404`、`check_in_not_found`）。対象日の範囲制限はない。
- `PUT` の body は `{ mood?, difficulty?, note? }`（`mood`/`difficulty` は 1〜5 の整数、`note` は 1000 文字以内で改行・タブのみ許可）。`PUT` は対象日のチェックイン全体の置き換えで、省略した項目は未設定（`null`）になる。3 項目がすべて未設定の入力は `422`（`invalid_check_in`）。
- `PUT` の対象日は actor の「今日」から過去 7 日まで。範囲外は `422`（`check_in_date_out_of_range`）。習慣の有無・予定の有無は問わない。
- 自然キー `(user, date)` で冪等であり `Idempotency-Key` は使わない。並行送信は後勝ちで 1 レコードに収束する。成功は常に `200`。状態変更の共通要件は `/habits` と同じ。rate limit は未対応。
- 履歴・期間取得と削除は対象外。

`/dashboard` の正式な契約は [../specs/statistics-dashboard.md](specs/statistics-dashboard.md) の API and Events 節と `packages/contracts/src/dashboard.ts` を正本とし、上記の一覧からの差分は次のとおり。

- `GET /dashboard` は `from`/`to` を受け付けない。actor の「今日」を含む直近 7 日・30 日の成功率と、習慣ごとの現在・最長ストリークを固定で返す（任意期間は必要になった時点で別 Spec）。
- 応答は `{ date, timezone, overall: { last7Days, last30Days }, habits: [{ habit: { id, kind, name }, currentStreak, longestStreak, last7Days, last30Days }] }`。期間の集計は `{ from, to, scheduled, success, missed, skipped, pending, successRate }` で、`successRate` は `success / (success + missed)`（0〜1）、分母 0 は `null`。
- 対象は active な習慣のみ。今日の未記録は `pending`（分母外）、過去の未記録は `missed`。`skipped` は分母から除外し、ストリークを切らず数えない。全体の成功率は合計件数から求める（習慣ごとの率の平均ではない）。
- 読み取り専用。認証は `401`、user が存在しなければ `404`（`user_not_found`）。`Idempotency-Key` と rate limit は不要/未対応。

`/weekly-reviews` の正式な契約は [../specs/weekly-review.md](specs/weekly-review.md) の API and Events 節と `packages/contracts/src/weekly-review.ts` を正本とし、上記の一覧からの差分は次のとおり。

- `POST /weekly-reviews` の body は `{ weekStart }`。`weekStart` はプロフィールの `weekStartsOn` に一致する週の開始日で、終了済みかつ直近 52 週以内のみ。違反は `422 week_not_reviewable`（理由は `fieldErrors.weekStart` の文言で区別）。新規作成は `201`＋`Location`、同じ週が既にあれば再計算せず `200` で既存を返す。`Idempotency-Key` は不要（週が自然な冪等キー）。
- `GET /weekly-reviews` は `limit`（1〜50、既定 20）と不透明な `cursor` で `weekStart` の新しい順に返し、`{ items, nextCursor }`。
- `PATCH /weekly-reviews/{reviewId}` の body は `{ reflection?: string | null, status?: "completed" }`（1 項目以上必須）。`reflection` は前後の空白を除去し、空は `null`（最大 1000 文字）。`status: "completed"` で確定し、確定後の PATCH は `409 weekly_review_already_completed`。他人・存在しない・UUID 形式でない ID は区別せず `404 weekly_review_not_found`。
- 応答 `WeeklyReview` は `{ id, weekStart, weekEnd, timezone, status, summary, reflection, completedAt, createdAt, updatedAt }`。`summary` は `schemaVersion: 1` のスナップショットで、`overall`・習慣ごと（`habitId`/`kind`/`name` と件数・`successRate`）・`checkIn`（`days`/`averageMood`/`averageDifficulty`）を持つ。自由記述（習慣の `purpose`/`cue`、チェックインのメモ）は含まない。
- 本タスクでは `POST /weekly-reviews/{reviewId}/analysis` と `/ai-jobs` は未実装（T-303/T-305）。

`/notification-settings` の正式な契約は [../specs/notification-preferences.md](specs/notification-preferences.md) の API and Events 節と `packages/contracts/src/notification-settings.ts` を正本とし、上記の表からの差分は次のとおり。

- ユーザー単位の設定のみ（習慣ごとの通知は対象外）。`GET` は未保存でも `200` で無効の既定値（`updatedAt: null`）を返す。
- `PUT` の body は `{ enabled, localTime, quietHours?, timezone? }`。`enabled` と `localTime`（`HH:mm`）は必須。`quietHours` は省略で既定の `22:00`〜`07:00`、`null` で quiet hours なし、`timezone` は省略でプロフィールの timezone。`PUT` は全体の置換で、`enabled: false` が配信停止。
- 有効（`enabled: true`）で送信時刻が quiet hours 内の場合は `422`（`reminder_time_in_quiet_hours`）。時刻・timezone・quiet hours の内容違反は `422`（`invalid_notification_setting`）。
- 自然な冪等な置換のため `Idempotency-Key` は使わない。成功は常に `200`。状態変更の共通要件は `/habits` と同じ。rate limit は未対応。
- メール内のワンクリック unsubscribe は T-402 で実装した（下記）。

`/notification-unsubscribe`（T-402）の正式な契約は [../specs/notification-delivery.md](specs/notification-delivery.md) の APIとイベント節と `packages/contracts/src/notification-delivery.ts` を正本とし、要点は次のとおり。

- `POST /api/v1/notification-unsubscribe?token=...` は認証不要の公開 endpoint で、メールの `List-Unsubscribe` / `List-Unsubscribe-Post: List-Unsubscribe=One-Click`（RFC 8058）が指す。token は HMAC 署名つき（用途と公開 ID のみ。有効期限なし）。有効なら該当ユーザーの設定を `enabled = false` にして `200 { "status": "unsubscribed" }`（冪等）、不正・改ざん・用途違いは理由を区別せず `400`（`invalid_token`）。
- `GET` は状態を変えず、確認用の最小 HTML を返す（メーラーのプリフェッチで勝手に停止されないため）。Origin 検証は行わず、token で保護する。
- 通知の配送そのものは API ではなく、スケジューラ（EventBridge）→ SQS（`deliveryId` のみの message）→ ワーカーで行う。SES の bounce/complaint は SNS → SQS で受ける。

## AI 境界

`AiCoachPort` は provider SDK を抽象化する。Application が渡すのは目的別 DTO のみで、provider 固有の response object を返さない。実装時点の公式仕様を再確認し、OpenAI 採用時は Responses API の Structured Outputs と function calling を Adapter 内に閉じ込める。

### T-302 で確定した AI 契約

正式な契約は [../specs/ai-contracts.md](specs/ai-contracts.md) と `packages/contracts/src/ai.ts`、`packages/application/src/ai` を正本とし、上記の案からの差分は次のとおり。

- 出力は `schemaVersion: "1"` を持ち、`WeeklyImprovementPlanV1` に加えて習慣設計用の `HabitDesignProposalV1` を定義する。入力は `HabitDesignInputV1` / `WeeklyImprovementInputV1` で、AI 用 `subjectId`(UUID)のみを識別子とする。
- `AiCoachPort.generate` は `completed`(`rawOutput: unknown`)または `refusal` を返し、失敗は分類した `AiCoachProviderError` で投げる。tool 呼び出しは許可しない。
- 提案の唯一の入口は `generateSafeCoaching`。`source: "ai"` は validator が `pass` した本文のみで、それ以外は versioned fallback(`fallbackReason` つき)。`required_human_review` は本文を公開せず fallback を返す。
- 再試行は `rate_limited`/`timeout`/`server_error`/`connection` のみ最大 3 attempt、validator 拒否後の再生成は最大 1 回。schema 不合格・refusal は再試行しない。

### 入力最小化

- 表示名・メール・内部 ID を送らない
- AI 用のランダムな subject ID、習慣種別、習慣文、決定論的集計、ユーザーが明示入力した振り返りだけを送る
- 自由記述の長さ制限、制御文字除去、prompt injection をデータとして区切る
- provider のデータ保持設定、リージョン、学習利用条件を契約前に確認する

### 第三者コンテンツ・ブランド保護

- system prompt に、特定の著作物の本文・翻訳・図表・ワークシート・固有の具体例や構成を再現しないこと、著者の文体模倣をしないこと、提携・監修を示唆しないことを明記する
- RAG、few-shot、fixture、eval dataset は `source_id`, `rights_basis`, `allowed_uses`, `reviewed_at`, `expires_at` を持つ allowlist の資料だけを使用し、権利根拠が不明または期限切れの資料は投入前に拒否する
- ユーザー入力に書籍本文等が含まれる可能性を前提とし、モデルへはタスク達成に必要な最小部分だけを data として渡す。入力されたこと自体を複製・保存・再配布の許諾とみなさない
- 出力 schema に `contentSafety.status` (`pass|fallback|required_human_review`) と `reasonCodes` を追加する。モデルの自己申告だけで合否を決めず、Application 層の決定論的 validator を必ず通す
- validator は、管理された第三者名称・誤認表示、引用を示す長文、許可資料との過度な文字列一致、出典・権利根拠のない固有表現を検査する。疑義がある出力は保存・表示せず、独自の定型 fallback へ切り替える
- 第三者名への単なる言及と権利侵害を機械判定だけで断定しない。商品名・機能名・販促利用、素材収録、公開引用は `required_human_review` とし、公開処理から分離する

### 構造化出力

例: `WeeklyImprovementPlanV1`

```json
{
  "summary": "string",
  "observations": [{ "evidence": "string", "interpretation": "string" }],
  "suggestions": [
    {
      "title": "string",
      "rationale": "string",
      "changeType": "cue|minimum_action|schedule|environment|no_change",
      "proposedValue": "string|null",
      "confidence": "low|medium|high"
    }
  ],
  "safety": { "requiresHumanSupport": false, "message": null }
}
```

- JSON Schema は `additionalProperties: false`、必須項目、配列上限、文字列上限、enum を定義
- SDK helper の parse 結果であっても同じ Zod schema で再検証
- schema version と prompt version を結果に保存
- 観測は入力データの根拠を必須にし、因果関係を断定させない
- tool calling は読み取り専用の限定 tool から開始し、引数検証・認可・回数上限・監査を適用
- 習慣更新 tool をモデルへ直接公開しない。提案適用は別のユーザー操作

## タイムアウト・再試行・フォールバック

- API 接続/全体 timeout を設定し、AbortSignal で中断
- 429、408、5xx、接続失敗のみを指数 backoff + jitter で最大 3 attempt。validation/refusal/4xx は原則再試行しない
- SQS visibility timeout は Lambda timeout より十分長くし、部分 batch failure を使用
- idempotency は `ai_job_id + prompt_version + input_fingerprint`
- 全失敗後は DLQ とし、週次集計から生成する規則ベース案（例: 最小行動を半分にする、時間帯見直し）を `fallback` と明示
- 第三者コンテンツ validator の拒否は再生成を最大 1 回に限定し、再度拒否された場合は第三者固有表現を含まない versioned fallback を表示する
- circuit breaker とユーザー/組織単位 rate limit・コスト上限を用意

## AI 評価

- 固定 fixture による schema 遵守、根拠整合、安全性、実行可能性の offline eval
- 第三者文章の再現要求、翻訳要求、文体模倣、書籍固有の構成再現、公式・監修を装う要求、ユーザー入力内の転載指示を含む adversarial fixture を必須にする
- 評価指標に `third_party_content_block_rate`, `false_positive_rate`, `brand_confusion_pass_rate`, `fallback_rate` を含め、公開前に human-reviewed golden dataset の基準を満たす
- prompt/model 変更時は versioned golden dataset を CI または staging で評価
- 本番は成功率、validation failure、refusal、latency、token/cost、fallback 率を記録
- 提案採用率は品質シグナルだが、ユーザー成果と同一視しない

OpenAI 採用時の根拠: [Responses API は structured JSON と strongly typed な custom function calls を提供する](https://developers.openai.com/api/reference/cli/resources/responses/methods/create)。プロバイダー最終決定時に Claude の公式仕様・データ取扱いも同じ観点で比較する。

### 追記(T-215): 日付指定の予定

- `GET /api/v1/schedule/{date}`: 今日から過去 7 日前までの日付に予定された active な習慣と、その日の記録を返す。応答は `GET /api/v1/schedule/today` と同じ形(`date` は指定日)。範囲外・未来日は `422`(`entry_date_out_of_range`)、不正な暦日は `422`(`validation_failed`)。認証必須。
- `GET /api/v1/schedule/today` と `GET /api/v1/schedule/{date}` の応答に `earliestDate`(記録を補正できる最も古い暦日)を追加する(後方互換な追加)。詳細は [specs/today-screens.md](specs/today-screens.md) TUI-005。
