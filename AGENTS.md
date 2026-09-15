# AGENTS.md

## Purpose

このファイルは、本リポジトリで作業するAIエージェントと開発者に適用する共通ルールである。目的は生成速度ではなく、保守性、型安全性、セキュリティ、テスタビリティ、変更容易性、運用性、可観測性を保った開発である。

ユーザーまたは上位の指示と矛盾する場合は上位の指示を優先し、矛盾を明示する。この配下により具体的な`AGENTS.md`がある場合、そのディレクトリ以下では具体的な指示も適用する。

## Read Before Work

作業開始前に、依頼へ関係する文書を読む。

- 全体: [`README.md`](README.md)
- プロダクト要件: [`docs/01-product-requirements.md`](docs/01-product-requirements.md)
- ユースケース: [`docs/02-use-cases.md`](docs/02-use-cases.md)
- アーキテクチャ: [`docs/03-architecture.md`](docs/03-architecture.md)
- DB: [`docs/04-database-design.md`](docs/04-database-design.md)
- API/AI: [`docs/05-api-and-ai-design.md`](docs/05-api-and-ai-design.md)
- 品質/運用: [`docs/06-quality-and-operations.md`](docs/06-quality-and-operations.md)
- Security: [`docs/08-security.md`](docs/08-security.md)
- 未決事項: [`docs/10-decisions-and-open-questions.md`](docs/10-decisions-and-open-questions.md)
- 実装前ゲート: [`docs/governance/implementation-readiness-gate.md`](docs/governance/implementation-readiness-gate.md)
- 完了条件: [`docs/governance/definition-of-done.md`](docs/governance/definition-of-done.md)
- 変更区分: [`docs/governance/change-classification.md`](docs/governance/change-classification.md)

関連文書を読まずに既存仕様を推測しない。文書とコードが矛盾する場合は、勝手にどちらかを正とせず、差異と影響を報告して解消する。

## Required Workflow

すべての変更は次の順で進める。

1. Design
2. Implementation
3. Testing
4. Self-review

### Before Implementation

1. [`change-classification.md`](docs/governance/change-classification.md) に従い、変更を`Standard`、`Lightweight`、`Emergency`に分類する。
2. 既存コード、Spec、API、DB、event、infra、security、operationsへの影響を確認する。
3. Standard変更はFeature SpecとImplementation Planを作成する。
4. Standard変更は[`implementation-readiness-gate.md`](docs/governance/implementation-readiness-gate.md)を通過し、Specが`Status: Ready`になるまで実装しない。
5. 実装を左右する未決事項がある場合は、推測して実装せずユーザーへ確認する。

テンプレート:

- [`docs/templates/feature-spec.template.md`](docs/templates/feature-spec.template.md)
- [`docs/templates/implementation-plan.template.md`](docs/templates/implementation-plan.template.md)

### During Implementation

- 依頼されたScopeに限定し、無関係なリファクタリングを混ぜない。
- 既存変更を所有者の許可なく破棄、上書き、revertしない。
- 小さくレビュー可能な差分を作る。
- 実装と同時に必要なテスト、Migration、observability、文書を更新する。
- destructive operation、外部への送信、本番変更は対象と権限を確認する。

### Before Completion

- [`definition-of-done.md`](docs/governance/definition-of-done.md)を確認する。
- 変更全体のdiffを読み、Spec適合、境界、エラー処理、認可、ログ、後方互換性をセルフレビューする。
- 利用可能な必須品質コマンドをすべて実行する。
- 実行できなかった検証は、理由と残存リスクを完了報告に明記する。
- 実装しただけで、テスト未実行または失敗中の状態を完了と報告しない。

## Architecture Rules

依存方向は次を守る。

```text
Presentation -> Application -> Domain
Infrastructure -> Application/Domain ports
```

- DomainはReact、Next.js、ORM、AWS SDK、AI SDK、HTTP、DBへ依存しない。
- Applicationはuse case、認可判断、transaction境界、portを担当する。
- InfrastructureはDB、IdP、AI、queue、email、clock等のadapterを担当する。
- PresentationはHTTP/UIとApplication DTOの変換を担当し、業務ロジックを持たない。
- module間の非公開実装やtableを直接操作せず、公開Application APIまたはdomain eventを使う。
- framework/provider固有型をDomain/Applicationの公開契約へ漏らさない。

## TypeScript Rules

- `strict: true`を維持する。
- 原則として`any`を使わない。外部入力は`unknown`として受け、runtime schemaで絞り込む。
- 型assertion、non-null assertion、`@ts-ignore`は最終手段とし、必要性を説明する。
- API、event、AI output、environment variablesを実行時にvalidationする。
- exhaustive checkを用い、状態やenum追加時の取りこぼしをcompile timeで検知する。
- Domain/Application APIは明示的な型とerror modelを持つ。

## Database Rules

- DB schema変更には必ず新しいMigrationを追加し、適用済みMigrationを編集しない。
- PostgreSQLの型、constraint、FK、index、transaction、lockへの影響を確認する。
- すべてのFKについて、アクセスパターンに合うindexの要否を確認する。
- 時刻は原則`timestamptz`でUTC保存し、習慣上のローカル日は`date`、timezoneはIANA IDとして扱う。
- 後方互換が必要な変更はexpand/contractを使用する。
- runtime roleとmigration roleを分離し、最小権限にする。
- Migrationはfresh databaseと既存schemaからのupgradeの両方を検証する。

## API and Async Rules

- API/eventの入力は境界でvalidationし、内部errorや機微情報をresponseへ漏らさない。
- resource queryにはactor IDを含め、他ユーザーのresourceは原則404として扱う。
- 更新競合、冪等性、pagination、入力上限、rate limitの要否を確認する。
- queue consumerはat-least-once deliveryを前提に冪等にする。
- retryは一時的障害に限定し、回数上限、exponential backoff、jitter、DLQを設ける。
- 外部APIには明示的なtimeout、abort、error classification、fallbackを設ける。

## AI Rules

- AIにユーザー設定の自動変更や最終判断を任せない。変更はユーザーの明示承認後に決定論的なuse caseが適用する。
- 入力データを最小化し、email、認証情報、不要な内部IDをproviderへ送らない。
- Structured Outputを使用し、アプリケーション側でもruntime validationする。
- prompt、input schema、output schema、modelをversion管理する。
- toolはallowlist方式とし、引数validation、認可、timeout、呼出回数上限、監査を設ける。
- 不正出力、refusal、timeout、rate limit、provider障害のfallbackを定義する。
- AI prompt、自由記述、raw responseを通常ログへ出さない。
- AI変更にはschema遵守、根拠整合性、安全性、実行可能性のevalを追加する。

## Third-Party Content and Intellectual Property Rules

- 特定の書籍、著者、講座、アプリ、ブランドは着想源に留め、本文、翻訳、図表、ワークシート、具体例、固有の説明順序を複製または近似再現しない。
- 一般的な方法・アイデアは、複数の適法な情報源と一次資料を確認し、独自の用語、構成、文章、UIとして設計する。出典表示は無許諾転載の代替にしない。
- 第三者の書籍名、著者名、ロゴ、表紙、キャッチコピーを、アプリ名、機能名、販促表示、seed、fixture、prompt、golden datasetへ権利確認なく使用しない。
- 公式、提携、監修、公認であるとの誤認を生む表示を禁止する。比較・批評等で名称への言及が必要な場合も、必要最小限かつ事実に限定する。
- AI/RAGの参照資料は、権利、利用条件、取得元、用途、保持期限を記録したallowlist方式とする。出所または利用権限が不明な資料は取り込まない。
- AI出力は第三者コンテンツの再現要求、ブランド混同、長い引用、出所不明の定型表現を検査し、疑義があれば生成結果を破棄して権利上安全な定型fallbackへ切り替える。
- ユーザーが第三者コンテンツを入力しても、それを再配布可能とはみなさない。保存、provider送信、出力への再掲は目的上必要な最小範囲に限定する。
- 法的適否をAIだけで最終判断しない。公開名称、マーケティング利用、第三者素材の収録、海外展開はhuman reviewの対象とし、必要に応じて弁護士・弁理士へ確認する。

## Security and Privacy Rules

- 認証と認可を別の関心事として扱い、すべての操作で認可する。
- IDOR/BOLA、XSS、CSRF、Injection、権限昇格、abuseを変更ごとに確認する。
- Secretをcode、test fixture、log、error response、documentationへ記載しない。
- email、token、cookie、自由記述、AI入出力をログへ記録しない。
- test dataは架空データのみを使用する。
- Admin操作は通常ユーザーと権限を分離し、監査可能にする。
- 個人情報の収集、外部送信、保持、export、削除への影響を確認する。

## Testing Rules

- 新機能にはテストを追加する。
- Domain/Applicationの重要な業務ルールはUnit Testで検証する。
- DB constraint、repository、transaction、認可、外部adapterはIntegration Testで検証する。
- 主要ユーザーフローはPlaywright E2Eで検証する。
- bug fixでは、修正前に失敗し修正後に成功する回帰テストを追加する。
- 日付、timezone、DST、競合、重複、timeout、retry、権限拒否を該当時に検証する。
- testを通すためにassertionを弱めたり、根拠なくskipやretryを追加したりしない。

## Documentation Rules

変更内容に応じて正本を更新する。

| Change                       | Required documentation                |
| ---------------------------- | ------------------------------------- |
| ユーザー向け仕様・業務ルール | Product requirement / Feature Spec    |
| API・event契約               | OpenAPI / event schema / Feature Spec |
| DB schema                    | Migration / DB design                 |
| 重要な技術判断               | 新しいADR。過去ADRを書き換えない      |
| 運用・障害対応               | Runbook / observability design        |
| 実装手順・rollout            | Implementation Plan                   |

文書を更新しない場合も、PRに変更不要の理由を記載する。

## Repository Commands

T-004（DB baseline/migration）完了時点で実行可能なcommand。

```text
pnpm format:check
pnpm lint
pnpm lint:boundaries    # dependency-cruiserによるlayer境界・循環依存チェック
pnpm typecheck
pnpm build
pnpm test:unit          # `*.integration.test.ts`を除く *.test.ts
pnpm test:integration   # `*.integration.test.ts`のみ。Dockerが必要
pnpm db:up              # docker composeでローカルPostgresを起動
pnpm db:down            # ローカルPostgresを停止
pnpm db:migrate:dev     # ローカルDBへPrisma migrationを対話的に適用(packages/infrastructure)
pnpm db:migrate:deploy  # 保留中のmigrationを適用(CI/本番相当)
```

`prisma migrate reset`等、DBを破壊的にリセットするコマンドはAIエージェントからの実行を明示的にブロックされる（Prisma 7の安全機構）。実行する場合は必ずユーザーに対象環境と影響を説明し、明示的な同意を得てから`PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION`を設定する。

`pnpm test:e2e`はPlaywright導入後（T-101のE2Eシナリオ着手時）に追加する。それまでは存在しないコマンドや成功結果を推測して報告しない。

## Communication

- 着手時に変更区分、対象Spec、影響範囲を簡潔に共有する。
- 要件の曖昧さが結果を大きく変える場合は、実装前に確認する。
- 完了報告は変更内容、テスト結果、残存リスク、更新文書を含める。
- 「完了」「問題なし」といった結論は、実行した検証の証拠に基づいて述べる。
- 会話上の説明・報告はなるべく日本語で書く。ファイルパス、コード識別子、ドキュメント内で定義済みのID（例: T-002、ADR-003、Gate名）は原文のまま使用してよい。この方針はドキュメント本文の既存英語用語（Gate、ADR、Domain/Application/Infrastructure等）を書き換える対象ではない。
