# 3. システム構成案とディレクトリ

## 推奨方針

MVP は TypeScript モノレポ内のモジュラーモノリスとする。Web/API は Next.js、非同期ワーカーは Lambda としてデプロイ単位を分けるが、Domain/Application のコードは共有する。サービス間通信を早期導入せず、境界をコードで強制する。

## 論理構成

```text
Browser
  -> CloudFront + WAF
     -> Next.js Web/API (ECS Fargate)
        -> Application use cases
           -> Domain model
           -> PostgreSQL ports -> RDS PostgreSQL
           -> Queue ports      -> SQS
           -> Email ports      -> SES

EventBridge Scheduler -> scheduling Lambda -> SQS
SQS -> worker Lambda -> AI provider / SES -> RDS
                                |
                                -> DLQ + CloudWatch Alarm
```

## レイヤー責務と依存方向

| レイヤー | 責務 | 依存してよい先 |
|---|---|---|
| Domain | Entity、Value Object、業務ルール、純粋な集計 | 原則なし |
| Application | ユースケース、Port、認可判断、トランザクション境界 | Domain |
| Infrastructure | DB、AI、Email、Queue、Clock の Adapter | Application/Domain の interface |
| Presentation | Route Handler、Server Action、UI、DTO 変換 | Application、共有 schema |

Domain は React、Next.js、ORM、AWS SDK、AI SDK を import しない。Application は HTTP や具体 DB エラーを知らない。Infrastructure の例外は Application のエラー型へ変換する。

## モジュール境界

- `identity`: アプリ内ユーザー、プロフィール、権限（認証基盤の Adapter は別）
- `habits`: 習慣、スケジュール版、アーカイブ
- `tracking`: 予定機会、実行記録、日次チェックイン、集計
- `reviews`: 週次レビュー、集計スナップショット
- `coaching`: AI ジョブ、提案、プロンプト/スキーマ版
- `notifications`: 設定、送信予定、配送結果
- `admin`: 管理者専用クエリと監査

モジュール間は公開 Application API または domain event を通す。別モジュールのテーブルを UI から直接結合して更新しない。

## ディレクトリ構成案

```text
.
├── apps/
│   ├── web/
│   │   ├── src/app/                 # Next.js routes/layouts
│   │   ├── src/presentation/        # UI, presenters, route adapters
│   │   └── tests/e2e/
│   └── workers/
│       └── src/handlers/            # Lambda entry points (薄く保つ)
├── packages/
│   ├── domain/
│   │   └── src/{identity,habits,tracking,reviews,coaching}/
│   ├── application/
│   │   └── src/{module}/{use-cases,ports,dto}/
│   ├── infrastructure/
│   │   └── src/{database,auth,ai,queue,email,observability}/
│   ├── contracts/                    # API/event schemas, generated OpenAPI types
│   ├── config/                       # 型付き環境設定
│   └── test-support/                 # factories, builders, containers
├── database/
│   ├── migrations/
│   └── seeds/                        # 非本番、架空データのみ
├── infra/
│   ├── modules/
│   └── environments/{dev,staging,prod}/
├── docs/
├── .github/workflows/
├── package.json
└── tsconfig.base.json
```

## 技術判断

- Package manager: pnpm workspace。高速で依存境界を明示しやすい。
- ORM/Query: Prisma または Drizzle は未決。どちらでも repository port の外に漏らさない。
- 認証: Auth.js（NextAuth）を採用（[ADR-001](adr/ADR-001-authentication.md)）。email+password（Credentials provider）を主手段、Google/GitHub OAuth を補助手段とし、独自パスワード実装（hash/reset）は自前で行う。
- API: 同一 Web クライアント向けは REST Route Handler。外部公開を見越して `/api/v1` と OpenAPI を用意。
- 時刻: Application へ `Clock` を注入。DB は `timestamptz`、習慣日付は `date`、タイムゾーンは IANA ID。
- 集計: MVP は問い合わせ時またはレビュー作成時に計算。負荷計測前に集計テーブルを増やさない。

## 境界の自動検証

- ESLint の import 制約で Domain → Infrastructure/Presentation を禁止
- TypeScript project references または package exports で非公開モジュールを隠す
- `dependency-cruiser` 等で循環依存を CI 検知
- API、イベント、AI 出力は Zod 等の schema から TypeScript 型を導出
