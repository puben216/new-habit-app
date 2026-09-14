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

`PUT /habits/{habitId}/entries/{date}` は `status` に加えて `quantity`（当日の実施回数、`build` の target_count が複数の場合に使用）を受け付ける。

## AI 境界

`AiCoachPort` は provider SDK を抽象化する。Application が渡すのは目的別 DTO のみで、provider 固有の response object を返さない。実装時点の公式仕様を再確認し、OpenAI 採用時は Responses API の Structured Outputs と function calling を Adapter 内に閉じ込める。

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
