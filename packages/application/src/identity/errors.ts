/**
 * 対象の user/プロフィールが存在しない、または actor の所有ではない場合。
 * 存在を漏らさないため、両者を区別せず Presentation で 404 へ変換する(docs/specs/user-profile.md PROF-007)。
 */
export class ProfileNotFoundError extends Error {
  constructor() {
    super("profile not found");
    this.name = "ProfileNotFoundError";
  }
}
