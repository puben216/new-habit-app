import { createDefaultProfile, localDateAt } from "@habit-app/domain";

import type { Clock } from "../auth";
import type { ProfileRepositoryPort } from "../identity/ports";

export interface LocalToday {
  readonly date: string;
  readonly timezone: string;
}

/**
 * actor の「今日」(プロフィール timezone のローカル暦日)を求める。`now()` はここで 1 回だけ呼ぶ
 * (日付境界での不整合を避けるため、呼び出し側は 1 リクエストにつき 1 回だけこの関数を使う)。
 * プロフィールが未作成なら既定値で作成して timezone を得る(T-102 の遅延作成)。
 * user が存在しない場合は `null`。
 */
export async function resolveLocalToday(
  profileRepository: ProfileRepositoryPort,
  now: Clock,
  actorUserId: string,
): Promise<LocalToday | null> {
  const profile = await profileRepository.ensure(actorUserId, createDefaultProfile());
  if (profile === null) return null;
  return { date: localDateAt(now(), profile.timezone), timezone: profile.timezone };
}
