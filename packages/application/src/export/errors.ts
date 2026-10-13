/**
 * データエクスポート use case の Application error。Presentation が HTTP status へ変換する。
 * メッセージにデータの内容・ユーザー識別子を含めない。再認証・アカウントの不存在は account のエラーを使う。
 */
export class ExportApplicationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** `queued`/`running` のエクスポートが既にある。 */
export class ExportInProgressError extends ExportApplicationError {
  constructor() {
    super("export in progress");
  }
}

/** 直近 24 時間の作成件数が上限に達している。 */
export class ExportRateLimitedError extends ExportApplicationError {
  constructor() {
    super("export rate limited");
  }
}

/** エクスポートが存在しない、または自分のものではない(区別しない)。 */
export class ExportNotFoundError extends ExportApplicationError {
  constructor() {
    super("export not found");
  }
}

/** まだ完成していない(`queued`/`running`)、または失敗した。 */
export class ExportNotReadyError extends ExportApplicationError {
  constructor() {
    super("export not ready");
  }
}

/** 期限を過ぎている。 */
export class ExportExpiredError extends ExportApplicationError {
  constructor() {
    super("export expired");
  }
}

/** queue への投入に失敗した。 */
export class ExportUnavailableError extends ExportApplicationError {
  constructor() {
    super("export unavailable");
  }
}
