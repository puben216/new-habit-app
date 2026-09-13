# <Feature Name> Spec

Status: Draft
Owner: TBD
Last updated: YYYY-MM-DD
Change classification: Standard
Roadmap Task: <T-XXX、または該当なしの理由>

## Goal

<解決するユーザー課題と提供価値>

## Success Metrics

- <測定可能な指標と成功基準>

## Scope

- <含めるもの>

## Out of Scope

- <含めないもの>

## Actors and Preconditions

| Actor | Preconditions |
|---|---|
| <actor> | <condition> |

## Functional Requirements

### <PREFIX>-001 <Requirement title>

- <外部から観測可能な振る舞い>

## Business Rules and Invariants

- <常に成立すべき規則>

## State Transitions

| Current | Action | Next | Rejected when |
|---|---|---|---|
| <state> | <action> | <state> | <condition> |

## Acceptance Criteria

```gherkin
Scenario: <name>
  Given <precondition>
  When <action>
  Then <observable result>
```

## Authorization Matrix

| Operation | Guest | Member | Admin | Ownership rule |
|---|---:|---:|---:|---|
| <operation> | No | Yes | No | Own resource only |

## API and Events

- <OpenAPI/event schemaへのリンク、またはN/A理由>

## Data and Migration

- <table、constraint、index、retention、migration、またはN/A理由>

## Failure and Edge Cases

- <timeout、競合、重複、空状態、境界値>

## Security and Privacy

- Data collected:
- Data sent externally:
- Data forbidden in logs:
- Threats and controls:

## AI Requirements

- <入力、出力schema、tool、validation、fallback、eval、またはN/A理由>

## Observability and Operations

- Logs:
- Metrics:
- Alerts:
- Runbook:
- Rollout/rollback:

## Test Coverage Matrix

| Requirement | Unit | Integration | E2E |
|---|---|---|---|
| <PREFIX>-001 | <case/N/A> | <case/N/A> | <case/N/A> |

## Open Questions

- <実装前に解決する問い。なければ「なし」>

## Implementation Readiness

Status: Not Ready
Reviewed at: —
Reviewed by: —

| Gate | Result | Evidence |
|---|---|---|
| Product | Fail | |
| Specification | Fail | |
| Domain and Time | Fail | |
| API and Data | Fail | |
| Security and Privacy | Fail | |
| AI | N/A | |
| Testing | Fail | |
| Operations | Fail | |
| Planning | Fail | |

### Accepted Risks

なし
