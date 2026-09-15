# 10. 設計上の意思決定と未決事項

## 現時点の提案（承認後 ADR 化）

| ID   | 論点               | 推奨                                                                       | 理由                                                                                            |
| ---- | ------------------ | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| D-01 | 初期アーキテクチャ | モジュラーモノリス                                                         | 小規模で運用負荷を抑えつつ境界を保てる                                                          |
| D-02 | Web hosting        | ECS Fargate + ALB                                                          | Next.js server と connection pool の挙動が明確                                                  |
| D-03 | DB                 | RDS PostgreSQL                                                             | 要件と AWS 統合に適合                                                                           |
| D-04 | API                | REST `/api/v1` + OpenAPI                                                   | MVP に十分で contract test が容易                                                               |
| D-05 | Async              | SQS + Lambda + DLQ                                                         | AI/通知を Web request から分離                                                                  |
| D-06 | 時刻               | UTC + IANA timezone + local `date`                                         | 日次習慣の意味を DST 下でも保持                                                                 |
| D-07 | AI 変更            | 提案のみ、明示承認で適用                                                   | 誤更新と過剰な自律性を防ぐ                                                                      |
| D-08 | AI 実行            | provider-neutral port + schema version                                     | Claude/OpenAI の交換・評価を可能にする                                                          |
| D-09 | 通知               | MVP は email のみ                                                          | delivery と opt-out の運用を小さく始める                                                        |
| D-10 | 管理画面           | read-only 中心                                                             | 個人データ露出と権限リスクを抑える                                                              |
| D-11 | 1 日複数回の対応   | `build` は target_count/quantity で複数回に対応、`reduce` は 1 日 1 回固定 | 記録・集計モデルを日単位のまま単純に保ちつつ、build の実用ニーズ（水を3回飲む等）に対応するため |

## P0 決定（ADR 化済み）

| ID    | 論点             | 決定                                                                                                                   | ADR                                           |
| ----- | ---------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| P0-01 | 認証             | Auth.js（NextAuth）。Credentials（email+password）を主手段、Google/GitHub OAuth を補助手段、admin は別途 TOTP 2FA      | [ADR-001](adr/ADR-001-authentication.md)      |
| P0-02 | ORM/migration    | Prisma                                                                                                                 | [ADR-002](adr/ADR-002-orm.md)                 |
| P0-03 | AI provider      | 未確定。Claude/OpenAI 両 adapter を pilot 導入し、T-305 完了時〜T-505 開始前に一次 provider を確定（Status: proposed） | [ADR-003](adr/ADR-003-ai-provider.md)         |
| P0-04 | Next.js hosting  | ECS Fargate。ただし初期は単一 AZ・固定 task 数の最小構成                                                               | [ADR-004](adr/ADR-004-hosting.md)             |
| P0-05 | メール           | Amazon SES。region は ap-northeast-1 候補、送信ドメイン取得は T-401 着手前までの follow-up                             | [ADR-005](adr/ADR-005-email.md)               |
| P0-06 | 法務             | 日本語ユーザー中心・日本法準拠、最低年齢18歳、削除後30日間の猶予期間                                                   | [ADR-006](adr/ADR-006-legal-baseline.md)      |
| P0-07 | 第三者コンテンツ | 一般的アイデアのみ独自表現で利用し、第三者素材・ブランドはallowlist、決定論的検証、fallback、human reviewで保護        | [ADR-007](adr/ADR-007-third-party-content.md) |
| P0-08 | Terraform配置    | `infra/` はアプリと同じモノレポに同居。チーム分業やT-502着手時に別リポジトリ分離を再評価                               | [ADR-008](adr/ADR-008-infra-repo-layout.md)   |

P0-03（AI provider）と P0-05（メールの region/ドメイン確定）は ADR 自体は accepted だが、内部に明記した期限までに follow-up の意思決定が必要。それ以外は着手可能。

## P1 決定

- 週の開始曜日の default、日本語/英語の初期対応範囲
- 未入力を UI で「未実施」と表示する確定タイミング
- 週次レビューを自動作成するか、初回アクセス時に遅延作成するか
- AI 結果の保存期間、ユーザーによる削除単位
- beta の対象人数と初期 SLO/cost budget

## P2 決定（実装時までに確定する運用パラメータ）

- Rate limit の具体的な閾値（endpoint / actor / IP 別のリクエスト数と時間窓）
- 通知の quiet hours のデフォルト値（開始・終了時刻、タイムゾーン基準）
- `habit_entries.note` 等、自由記述系フィールドの文字数上限

## 検証すべき仮説

- AI 設計案は手動フォームより activation を改善する
- 週次 AI 提案は一般的な定型文より翌週の実行率を改善する
- streak を強調しすぎない表示が、失敗後の復帰率を改善する
- reduce 習慣では「しなかった」記録より cue と replacement action の記録が有用

各仮説にはイベント、母数、評価期間、成功/中止基準を実装前に定義する。自由記述や AI 本文を analytics へ送らない。

## ADR テンプレート

```text
# ADR-NNN: タイトル
Status: proposed | accepted | superseded
Date:
Context:
Decision:
Alternatives considered:
Consequences:
Security/operational impact:
Review date:
```

## 設計レビューの完了条件

- P0 がすべて accepted ADR になっている
- MVP の各ユースケースに owner、受け入れ基準、テスト種別がある
- 認可 matrix、data retention、AI safety/fallback が合意済み
- 初期 AWS 月額上限と alarm 通知先が決まっている
- T-001〜T-005 を issue 化できる粒度になっている
