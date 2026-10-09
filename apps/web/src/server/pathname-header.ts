/**
 * proxy が付与する `x-pathname` の組み立て(docs/specs/auth-screens.md AUI-007)。
 *
 * Server Component の layout は現在の path を知らないため、未認証時の `next` を作る材料として使う。
 * client が同名の header を送ってきても必ず上書きする(信用しない)。値は `parseNextPath` で再検証される。
 */
export const PATHNAME_HEADER = "x-pathname";

export interface PathnameSource {
  readonly headers: Headers;
  readonly nextUrl: { readonly pathname: string; readonly search: string };
}

export function withPathnameHeader(request: PathnameSource): Headers {
  const headers = new Headers(request.headers);
  // RSC の内部 query(`_rsc`)は利用者の URL ではないので除く。
  const params = new URLSearchParams(request.nextUrl.search);
  params.delete("_rsc");
  const query = params.toString();
  headers.set(PATHNAME_HEADER, `${request.nextUrl.pathname}${query === "" ? "" : `?${query}`}`);
  return headers;
}
