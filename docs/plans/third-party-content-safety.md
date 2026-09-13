# Third-Party Content Safety Implementation Plan

Status: Draft
Owner: TBD
Last updated: 2026-09-13
Spec: [Third-Party Content Safety Spec](../specs/third-party-content-safety.md)
Change classification: Standard

## Approach

T-302のAI contract基盤に、rights registry port、versioned output validator、公開判定、fail-closed fallbackを追加する。provider adapterの前後で責務を分け、モデルやpromptだけに公開可否を委ねない。T-304/T-305は同じApplication policyを必ず経由する。

## Impact Analysis

| Area | Change | Risk |
|---|---|---|
| Domain | content safety status/reasonの型 | reason追加時の取りこぼし |
| Application | rights確認、validator、公開gate、fallback | false negative/positive |
| Infrastructure | provider adapter、rights registry adapter | provider差、設定不備 |
| Presentation | fallbackとreview-required表示 | 誤認・内部理由の露出 |
| Database | version/status/reason metadata候補 | schemaはT-302で確定 |
| API/Event | contentSafety contract追加 | version互換性 |
| AWS/Terraform | 原則なし | registry保存方式次第 |
| Observability | 本文なしのmetrics/alarm | 機微本文のlog混入 |

## Interfaces and Contracts

- `ThirdPartyRightsRegistryPort`: sourceとallowed useの判定
- `GeneratedContentValidator`: outputからstatus/reasonを返す純粋なApplication/Domain service
- `SafeCoachingFallbackPort`:目的別のversioned定型案
- AI job result: `contentSafety.status`, `reasonCodes`, `validatorVersion`, `fallbackVersion`

## Data Migration

T-302の初期schemaと同時に設計するため既存データmigrationはN/A。永続化するのは本文ではなく判定metadataを原則とし、rollbackはAI feature flag停止とfallback固定で行う。

## Security Review

- Authentication/authorization: 既存AI job所有権を継承。rights registry変更は運用者のreview必須
- PII/secrets/logging: 入出力本文、引用候補、promptをlog禁止。reason codeのみ記録
- Abuse controls: 入力長上限、rate limit、再生成1回、provider call上限

## Test Plan

| Requirement | Test level | Planned test |
|---|---|---|
| IPG-001 | Unit/Integration | 未承認・期限切れ・用途外資料をdeny |
| IPG-002 | Unit/Eval | 転載、翻訳、文体模倣、構成再現、誤認fixture |
| IPG-003 | Unit/Integration | pass以外を保存・表示しない |
| IPG-004 | Integration/E2E | validator例外でも未検証本文を公開しない |
| IPG-005 | Unit/Integration | 公開用途をhuman reviewへroute |
| IPG-006 | Integration | log sinkに本文がない |

## Rollout and Operations

- Feature Flag: provider/model/prompt/validator versionとAI提案公開を独立制御
- Deployment order: schema/registry → validator/fallback → fake/eval → UI → 段階公開
- Metrics/alarms: status/reason別件数、false positive sample review、fallback急増
- Rollback: AI提案公開flagを停止し、決定論的fallbackのみ返す

## Task Breakdown

1. Open Questionsを解消しSpec reviewとReadiness Gateを完了する。
2. versioned schema、reason code、rights registry port、fallback contractを実装してUnit Testを追加する。
3. provider fakeとadversarial/happy-path datasetを作成し、validator pipelineをIntegration Testする。
4. T-304/T-305の保存・表示経路を公開gate経由にし、E2Eでfail closedを確認する。
5. 本文を含まないmetrics/alarm/runbookを追加し、diffとlog出力をセルフレビューする。

## Dependencies

- T-002〜T-005、T-302
- ADR-007
- beta前のgolden dataset reviewerとfalse positive閾値の決定

## Risks

| Risk | Mitigation | Owner |
|---|---|---|
| 検知漏れ | prompt、deterministic validator、human reviewの多層化 | TBD |
| 過剰拒否 | 一般助言fixtureとfalse positive計測 | TBD |
| 本文のlog漏洩 | typed logging API、禁止field test、sink検証 | TBD |
| registry誤設定 | deny by default、review、期限、監査 | TBD |

## Start Conditions

- [ ] Spec StatusがReady
- [x] 必須ADRがAccepted
- [ ] API/event契約がレビュー済み
- [ ] Migration方針がレビュー済み、またはN/A確定
- [x] 認可・データ保護方針が記載済み
- [ ] テスト環境とFake/Stubを準備できる
- [ ] 依存taskが完了している
- [x] rollout/rollback方針が決定している
- [ ] 実装前ゲートの全必須項目がPassまたは根拠付きN/A
