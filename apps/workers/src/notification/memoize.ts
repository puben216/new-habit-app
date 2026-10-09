/**
 * 非同期の初期化を 1 回だけ実行して共有する(Lambda の実行環境内で再利用するため)。
 * 成功した結果は保持するが、失敗はキャッシュしない: 一時的な障害(起動直後の Secrets/DB の不調など)で
 * 初期化に失敗しても、次の invocation で再試行できる(失敗した Promise を保持し続けると、
 * 実行環境が入れ替わるまで毎回失敗してしまう)。同時に呼ばれた場合は 1 回の初期化を共有する。
 */
export function memoizeAsync<T>(factory: () => Promise<T>): () => Promise<T> {
  let cached: Promise<T> | undefined;
  return () => {
    if (cached === undefined) {
      const attempt = factory();
      cached = attempt;
      attempt.catch(() => {
        if (cached === attempt) cached = undefined;
      });
    }
    return cached;
  };
}
