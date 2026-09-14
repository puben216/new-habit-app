# <Feature Name> Implementation Plan

Status: Draft
Owner: TBD
Last updated: YYYY-MM-DD
Spec: <relative link>
Change classification: Standard

## Approach

<Specを実現する実装方針。要件を繰り返さず、変更方法を書く>

## Impact Analysis

| Area           | Change | Risk |
| -------------- | ------ | ---- |
| Domain         |        |      |
| Application    |        |      |
| Infrastructure |        |      |
| Presentation   |        |      |
| Database       |        |      |
| API/Event      |        |      |
| AWS/Terraform  |        |      |
| Observability  |        |      |

## Interfaces and Contracts

- <追加・変更するport、DTO、API、event、AI schema>

## Data Migration

- Expand:
- Backfill:
- Switch:
- Contract:
- Rollback/forward fix:

N/Aの場合は理由を記載する。

## Security Review

- Authentication/authorization:
- PII/secrets/logging:
- Abuse controls:

## Test Plan

| Requirement | Test level           | Planned test |
| ----------- | -------------------- | ------------ |
| <ID>        | Unit/Integration/E2E | <case>       |

## Rollout and Operations

- Feature Flag:
- Deployment order:
- Metrics/alarms:
- Rollback trigger and procedure:

## Task Breakdown

1. <独立してレビュー・検証できるtask>
2. <task>

各taskは「設計確認 → 実装 → テスト → セルフレビュー」を含む。

## Dependencies

- <先行task、外部権限、provider、ADR>

## Risks

| Risk | Mitigation | Owner |
| ---- | ---------- | ----- |
|      |            |       |

## Start Conditions

- [ ] Spec StatusがReady
- [ ] 必須ADRがAccepted
- [ ] API/event契約がレビュー済み、またはN/A
- [ ] Migration方針がレビュー済み、またはN/A
- [ ] 認可・データ保護方針がレビュー済み
- [ ] テスト環境とFake/Stubを準備できる
- [ ] 依存taskが完了している
- [ ] rollout/rollback方針が決定している
- [ ] 実装前ゲートの全必須項目がPassまたは根拠付きN/A
