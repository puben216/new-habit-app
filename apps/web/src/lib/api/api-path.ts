/**
 * API client が request できる path の検証(docs/specs/web-ui-foundation.md WUI-004、WUI-INV-005)。
 *
 * 同一 origin の `/api/v1/` 配下だけを許可し、絶対 URL・protocol-relative URL・
 * path traversal(`.`/`..`、エンコード済みを含む)・空白/制御文字・fragment を拒否する。
 */
export const API_PATH_PREFIX = "/api/v1/";

const ALLOWED_CHARACTERS = /^[A-Za-z0-9\-._~!$&'()*+,;=:@%/?]+$/;

function hasTraversalSegment(pathname: string): boolean {
  return pathname.split("/").some((segment) => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return true;
    }
    return decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\");
  });
}

export function isSafeApiPath(path: string): boolean {
  if (!path.startsWith(API_PATH_PREFIX) || path.length === API_PATH_PREFIX.length) return false;
  if (!ALLOWED_CHARACTERS.test(path)) return false;

  const queryStart = path.indexOf("?");
  const pathname = queryStart === -1 ? path : path.slice(0, queryStart);
  if (pathname.includes("//")) return false;
  return !hasTraversalSegment(pathname);
}
