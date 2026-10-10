/**
 * AI job use case の Application error。Presentation が HTTP status へ変換する。
 * メッセージに入力・自由記述・ユーザー識別子を含めない。
 */
export class AiJobApplicationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** job が存在しない(他ユーザーの job を含む。存在を区別しない)。 */
export class AiJobNotFoundError extends AiJobApplicationError {
  constructor() {
    super("ai job not found");
  }
}

/** 分析の対象レビューが `completed` でない(AJOB-001)。 */
export class WeeklyReviewNotCompletedError extends AiJobApplicationError {
  constructor() {
    super("weekly review is not completed");
  }
}

/** レビューから AI の入力を組み立てられない(schema 不適合)(AJOB-002)。 */
export class AnalysisInputInvalidError extends AiJobApplicationError {
  constructor() {
    super("analysis input is invalid");
  }
}

/** 同時実行中の job が上限に達している(AJOB-001)。 */
export class AiJobLimitReachedError extends AiJobApplicationError {
  constructor() {
    super("active ai job limit reached");
  }
}

/** queue へ投入できなかった。job は `queued` のまま残る(再依頼で再投入できる)。 */
export class AiQueueUnavailableError extends AiJobApplicationError {
  constructor() {
    super("ai queue unavailable");
  }
}

/** 保存済みの job 結果が schema に合わない(データ破損)。内容を含めない。 */
export class CorruptedAiJobError extends AiJobApplicationError {
  constructor() {
    super("persisted ai job violates invariants");
  }
}
