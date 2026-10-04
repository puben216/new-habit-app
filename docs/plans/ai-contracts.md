# AI Contracts / Fake Adapter Implementation Plan

Status: Ready
Owner: TBD
Last updated: 2026-10-04
Spec: [AI Contracts / Fake Adapter Spec](../specs/ai-contracts.md)
Change classification: Standard

## Approach

provider・DB・HTTP に触れず、型と境界だけを縦に薄く実装する。Contracts に schema、Domain に権利判定、Application に port・validator・fallback・pipeline、Infrastructure に fake と in-memory registry を置く。T-303/T-304/T-305 は `generateSafeCoaching` を唯一の入口として使い、公開可否を再実装しない。

## Impact Analysis

| Area           | Change                                            | Risk                                             |
| -------------- | ------------------------------------------------- | ------------------------------------------------ |
| Domain         | `ai/rights.ts`(権利 record と deny 判定)          | 判定漏れ → deny by default で緩和                |
| Application    | `ai/` 新規。`@habit-app/contracts` への依存を追加 | 依存方向。contracts は Domain/Infra に依存しない |
| Infrastructure | `ai/` に fake と in-memory registry               | 本番誤用 → 名前と JSDoc で明示、export は分離    |
| Presentation   | なし                                              | —                                                |
| Database       | なし(Migration N/A)                               | —                                                |
| API/Event      | HTTP なし。contracts の schema のみ               | version 互換 → `schemaVersion` で管理            |
| AWS/Terraform  | なし                                              | —                                                |
| Observability  | `AiAuditSinkPort`(本文なし)                       | 本文混入 → typed record と test                  |

## Interfaces and Contracts

- Contracts: `aiPurposeSchema`、`habitDesignInputV1Schema`、`weeklyImprovementInputV1Schema`、`habitDesignProposalV1Schema`、`weeklyImprovementPlanV1Schema`、`contentSafetySchema`、`CONTENT_SAFETY_STATUSES`、`CONTENT_SAFETY_REASON_CODES`
- Domain: `RightsRecord`、`evaluateRightsUse(record, use, now)`
- Application: `AiCoachPort`、`AiCoachProviderError`、`ThirdPartyRightsRegistryPort`、`AiAuditSinkPort`、`validateGeneratedContent`、`inspectGenerationRequest`、`buildSafeFallback`、`generateSafeCoaching`、`admitCorpusSource`、`COACHING_SYSTEM_POLICY_V1`
- Infrastructure: `createFakeAiCoach`、`createInMemoryRightsRegistry`

## Data Migration

N/A(DB 変更なし)。rollback は AI 公開 flag の停止。コードの revert のみで元に戻る。

## Security Review

- Authentication/authorization: 本 package は actor を扱わない。呼び出し側(T-303)が所有権を検証する。
- PII/secrets/logging: 入力 schema に PII を持たせない。監査は typed record のみ。本文・prompt をログに出す経路を作らない。
- Abuse controls: 入力長上限、retry 3、再生成 1、timeout。

## Test Plan

| Requirement | Test level | Planned test                                                         |
| ----------- | ---------- | -------------------------------------------------------------------- |
| AIC-001     | Unit       | `contracts/src/ai.test.ts`: valid/invalid/oversize/未知キー/制御文字 |
| AIC-002     | Unit       | `infrastructure/src/ai/fake-ai-coach.test.ts`                        |
| AIC-003     | Unit       | `application/src/ai/generate-safe-coaching.test.ts`                  |
| AIC-004     | Unit       | `application/src/ai/content-validator.test.ts`(adversarial/一般助言) |
| AIC-005     | Unit       | `application/src/ai/fallback.test.ts`                                |
| AIC-006     | Unit       | `domain/src/ai/rights.test.ts`、`application/src/ai/corpus.test.ts`  |
| AIC-007     | Unit       | pipeline test の監査 record 検査                                     |

## Rollout and Operations

- Feature Flag: `publicationEnabled`(呼び出し側が設定から供給。既定は無効側に倒す)
- Deployment order: contracts → domain → application → infrastructure。ユーザー影響なし
- Rollback: revert のみ

## Task Breakdown

1. Spec/Plan 作成と Readiness 確認(完了)。
2. Contracts schema とテスト。
3. Domain 権利判定とテスト。
4. Application port・validator・fallback・pipeline・corpus とテスト。
5. Infrastructure fake/in-memory registry とテスト。
6. `docs/05`・`docs/09`・`docs/10`・IPG Spec を更新し、全品質 command とセルフレビュー。

## Dependencies

- T-002〜T-005(完了)、ADR-003/007

## Risks

| Risk     | Mitigation                                  | Owner |
| -------- | ------------------------------------------- | ----- |
| 検知漏れ | 多層防御、flag 停止、T-505 前の golden 評価 | TBD   |
| 過剰拒否 | 一般助言 fixture、fallback 率の計測(T-303)  | TBD   |
| 本文漏洩 | typed 監査 record、禁止 field test          | TBD   |

## Start Conditions

- [x] Spec StatusがReady
- [x] 必須ADRがAccepted
- [x] API/event契約がレビュー済み
- [x] Migration方針がレビュー済み、またはN/A確定
- [x] 認可・データ保護方針が記載済み
- [x] テスト環境とFake/Stubを準備できる
- [x] 依存taskが完了している
- [x] rollout/rollback方針が決定している
- [x] 実装前ゲートの全必須項目がPassまたは根拠付きN/A
