# ADR-003: AI Provider（暫定・比較検証中）

Status: proposed
Date: 2026-09-13

Context:
初期習慣設計案・週次改善案（PRD FR-9）の一次 AI provider として OpenAI と Claude のどちらを採用するか、品質・レイテンシ・コスト・データ保持ポリシーの比較材料がまだない状態で確定させるのは時期尚早と判断した。

Decision:
provider-neutral な `AiCoachPort`（[05-api-and-ai-design.md](../05-api-and-ai-design.md)）を先に実装し、Claude / OpenAI 両方の adapter を fake adapter と並行して用意する。T-302（AI contracts/fake adapter）〜T-305（週次改善 coaching）の実装期間中、同一プロンプト・同一評価データセット（golden dataset）で両 provider を比較し、品質・レイテンシ・コスト・データ保持条件を評価する。一次 provider は T-305 完了時点、遅くとも T-505（限定 beta）開始前までに確定し、本 ADR を accepted へ更新する。

Alternatives considered:

- 先にどちらか一方を確定する: 比較データが無い状態での確定はコスト超過・品質低下のリスクがあるため見送り、pilot 期間を設けることにした。

Consequences:

- 両 provider 分の adapter 実装・API key 管理・評価 pipeline のぶん実装コストが増える。
- 最終決定まで両 provider 分の課金が発生し得るため、pilot 期間中の月額予算上限を明示的に設定する必要がある。

Security/operational impact:

- 両 provider とも、自由記述をプロンプトへ渡す際の PII 最小化、出力 schema 検証、tool allowlist/呼出回数上限を同一基準で適用する（[08-security.md](../08-security.md)）。
- provider ごとのデータ保持ポリシー（トレーニング利用有無、保持期間）を確認し、[08-security.md](../08-security.md) のデータ保護節へ反映する。
- プロンプト本文・AI 出力本文は通常ログに残さず、prompt/model/schema version と結果 status のみ監査する。

Review date: T-305 完了時。遅くとも T-505 開始前に一次 provider を確定し、本 ADR を accepted / superseded に更新する。
