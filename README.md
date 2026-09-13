# AI Habit Coach

行動科学と一般的な習慣形成の知見を参考に、習慣の設計・実行・振り返り・改善を支援する AI 習慣コーチ型 SaaS です。特定の書籍・著者・ブランドの公式、提携、監修サービスではありません。

現在は設計フェーズです。実装を開始する前に、以下の設計ドキュメントを合意します。

リポジトリで作業するAIエージェントと開発者の共通ルールは [`AGENTS.md`](AGENTS.md) を参照してください。

- [プロダクト要件と MVP](docs/01-product-requirements.md)
- [ユースケース](docs/02-use-cases.md)
- [システム構成とディレクトリ](docs/03-architecture.md)
- [DB 設計](docs/04-database-design.md)
- [API・AI 設計](docs/05-api-and-ai-design.md)
- [テスト・CI/CD・運用](docs/06-quality-and-operations.md)
- [AWS・Terraform](docs/07-infrastructure.md)
- [セキュリティ](docs/08-security.md)
- [ロードマップと MVP タスク](docs/09-roadmap.md)
- [設計上の意思決定と未決事項](docs/10-decisions-and-open-questions.md)
- [実装前ゲート](docs/governance/implementation-readiness-gate.md)
- [Definition of Done](docs/governance/definition-of-done.md)
- [変更区分](docs/governance/change-classification.md)
- [機能 Spec テンプレート](docs/templates/feature-spec.template.md)
- [実装 Plan テンプレート](docs/templates/implementation-plan.template.md)

## 設計原則

- Domain / Application / Infrastructure / Presentation の依存方向を守る。
- 最初はモジュラーモノリスとして小さく始め、計測結果をもとに分離する。
- TypeScript strict、`any` 禁止、境界入力のランタイム検証を徹底する。
- AI 出力を信頼せず、構造化・検証・フォールバック・監査を組み込む。
- 第三者コンテンツはアイデアと表現を区別し、無許諾の文章・翻訳・図表・固有の構成・ブランド表示を AI 入出力や検索資料へ組み込まない。
- ユーザーの自由記述、メールアドレス、AI 入出力を機微情報として扱う。
- すべての変更を「設計 → 実装 → テスト → セルフレビュー」で完了する。

## ドキュメントのステータス

初版（提案）。`docs/10-decisions-and-open-questions.md` の未決事項を決定後、ADR として固定し、実装へ進みます。

新機能の実装は、変更区分を判定し、機能 Spec と実装 Plan を作成したうえで実装前ゲートを通過してから開始します。緊急変更を除き、`Status: Ready` でない Spec の実装は開始しません。
