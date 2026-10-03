import { ProfileNotFoundError } from "./errors";
import type { Actor, ProfileRecord, ProfileView } from "./ports";

/**
 * 所有権 policy(docs/specs/user-profile.md PROF-007)。
 * repository の問い合わせは actor の user ID を条件にするが、多層防御として取得結果の所有者が
 * actor と一致することを再確認する。不一致は存在を漏らさない ProfileNotFoundError(404)にする。
 *
 * @throws {ProfileNotFoundError} record が null、または所有者が actor と異なる場合
 */
export function assertProfileOwnedByActor(
  actor: Actor,
  record: ProfileRecord | null,
): asserts record is ProfileRecord {
  if (record === null || record.userId !== actor.userId) {
    throw new ProfileNotFoundError();
  }
}

/** 内部 ID を含まない公開用の view へ変換する。 */
export function toProfileView(record: ProfileRecord): ProfileView {
  return {
    displayName: record.displayName,
    timezone: record.timezone,
    locale: record.locale,
    weekStartsOn: record.weekStartsOn,
    updatedAt: record.updatedAt,
  };
}
