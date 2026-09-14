# Third-Party Content Safety Spec

Status: Draft
Owner: TBD
Last updated: 2026-09-13
Change classification: Standard
Roadmap Task: T-302、T-304、T-305

## Goal

一般的な習慣形成の知見を活用しつつ、AIが第三者の著作物やブランド表現を再現・再配布したり、公式・提携・監修と誤認させたりする結果をユーザーへ提供しない。

## Success Metrics

- human-reviewed adversarial golden datasetで、明確な転載・翻訳・文体模倣・ブランド誤認ケースの公開通過率0%
- validator障害時に未検証AI出力が公開・永続化されるケース0件
- 一般的な習慣助言のfalse positive率をbeta開始前に定める閾値以下とする

## Scope

- AI habit designとweekly improvementのprompt、入力、構造化出力、決定論的validator、fallback、eval
- AI/RAG/few-shot/evalで使用する第三者資料のrights allowlist
- 商品名・機能名・販促・素材利用をhuman reviewへ送る境界

## Out of Scope

- 個別案件の法的適否の自動判定
- 第三者とのライセンス交渉
- ユーザーが私的に入力する内容そのものの事前検閲

## Functional Requirements

### IPG-001 権利資料allowlist

AIへ投入する第三者資料は、source ID、取得元、権利根拠、許可用途、review日時、期限を持ち、有効な承認がない資料を拒否する。

### IPG-002 生成制約

AIは第三者本文・翻訳・図表・ワークシート・固有の具体例や構成を再現せず、著者の文体を模倣せず、公式・提携・監修を示唆しない。

### IPG-003 決定論的公開ゲート

すべてのAI提案をApplication層のversioned validatorで検証し、`pass`以外の本文をユーザーへ表示・通常結果として永続化しない。

### IPG-004 Fail-closed fallback

validator拒否、timeout、例外、設定欠損時は未検証結果を破棄し、第三者固有表現を含まないversioned定型fallbackを返す。

### IPG-005 Human review

商品名、機能名、販促表示、第三者素材、公開引用はAIの判定だけで公開せず、権利確認を含むhuman reviewを必須とする。

### IPG-006 データ最小化と監査

ユーザー入力に第三者コンテンツが含まれる場合もprovider送信と再掲を必要最小限とし、監査ログには本文ではなくversion、status、reason codeだけを記録する。

## Business Rules and Invariants

- promptの自己申告だけで公開可否を決めない。
- 出典表示だけを転載許可の根拠にしない。
- `pass`していない生成本文は公開しない。
- rights allowlistの期限切れ・不明・許可用途外はdenyとする。
- 一般的アイデアへの言及を侵害と断定せず、公開用途で判断が必要なものはhuman reviewへ送る。

## Acceptance Criteria

```gherkin
Scenario: 明確な第三者文章の再現要求
  Given ユーザー入力が特定書籍の文章または翻訳の再現を要求する
  When AI提案を生成する
  Then 再現本文は表示も通常結果として保存もされず、安全なfallbackが返る

Scenario: 一般的な習慣助言
  Given 入力が第三者固有表現を要求していない
  When 独自表現の小さな習慣案がvalidatorを通過する
  Then 提案が表示される

Scenario: validator障害
  Given validatorがtimeoutまたは例外になる
  When AI結果の公開を試みる
  Then fail closedとなり未検証本文は公開されずfallbackが返る

Scenario: 権利根拠がない資料
  Given 資料に有効なrights recordがない
  When RAG corpusへ登録しようとする
  Then 登録は拒否され監査可能なreason codeが残る

Scenario: ブランドを販促へ使用する提案
  Given AIが第三者名を商品名または販促文へ使う案を生成する
  When 公開可否を判定する
  Then required_human_reviewとなり自動公開されない
```

## API and Events

- 既存AI job contractへ`contentSafety: { status, reasonCodes, validatorVersion }`を追加する。公開APIの詳細はT-302でversioned schemaとして確定する。
- DB/API実装前のため、現時点でmigrationは行わない。

## Security and Privacy

- Data collected: validator status、reason code、各version、rights metadata
- Data sent externally: 必要最小限のユーザー入力。権利確認のない第三者資料は送信しない
- Data forbidden in logs: 問題となった入力・生成本文、引用候補、AI prompt/response
- Controls: allowlist、length limit、structured output、deterministic validation、fail closed、human review

## AI Requirements

- prompt/schema/validator/fallbackを独立version管理する。
- validatorは管理されたブランド・誤認表示、長い引用形態、許可資料との過度な一致、危険な再現指示をreason code化する。
- validator拒否後の再生成は最大1回。再拒否時はfallbackとする。
- adversarial evalと一般助言のfalse positive evalをprovider/model/prompt変更時に実行する。

## Observability and Operations

- 本文なしのstatus/reason code別metricsを記録する。
- 急激な拒否率・human review率・fallback率増加をalarm候補とする。
- validatorまたはrights registry障害時はAI機能を縮退し、記録機能は継続する。

## Test Coverage Matrix

| Requirement | Unit                 | Integration               | E2E                        |
| ----------- | -------------------- | ------------------------- | -------------------------- |
| IPG-001     | rights rule/expiry   | registry deny             | N/A（内部境界）            |
| IPG-002     | adversarial fixtures | provider fake             | 再現要求→fallback          |
| IPG-003     | status transition    | 未検証結果の保存/表示拒否 | passのみ表示               |
| IPG-004     | timeout/exception    | fail-closed pipeline      | 障害時fallback             |
| IPG-005     | review routing       | 自動公開拒否              | N/A（MVP管理フロー未確定） |
| IPG-006     | redacted audit       | log sink検証              | N/A（本文を観測しない）    |

## Open Questions

- beta開始前のfalse positive率の許容閾値とgolden datasetのレビュー担当者
- human review queueをMVP管理画面に含めるか、公開対象機能自体をfeature flagで停止するか

## Implementation Readiness

Status: Not Ready
Reviewed at: —
Reviewed by: —

| Gate                 | Result | Evidence                             |
| -------------------- | ------ | ------------------------------------ |
| Product              | Pass   | Goal、Scope、IPG-001〜006            |
| Specification        | Fail   | Open Questionsとreviewer承認が未完了 |
| Domain and Time      | N/A    | 日付・時刻・状態変更を扱わない       |
| API and Data         | Fail   | T-302でschemaと永続化範囲を確定する  |
| Security and Privacy | Pass   | Security and Privacy節               |
| AI                   | Pass   | AI Requirements、Acceptance Criteria |
| Testing              | Pass   | Test Coverage Matrix                 |
| Operations           | Fail   | human review運用が未確定             |
| Planning             | Pass   | 対応Implementation Plan              |

### Accepted Risks

なし
