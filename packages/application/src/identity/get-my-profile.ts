import { createDefaultProfile } from "@habit-app/domain";
import { assertProfileOwnedByActor, toProfileView } from "./profile-policy";
import type { Actor, ProfileRepositoryPort, ProfileView } from "./ports";

export interface GetMyProfileDeps {
  readonly profileRepository: ProfileRepositoryPort;
}

/**
 * 自分のプロフィールを取得する(PROF-001)。未作成なら既定値で作成してから返す(遅延作成)。
 *
 * @throws {ProfileNotFoundError} actor の user が存在しない場合
 */
export async function getMyProfile(deps: GetMyProfileDeps, actor: Actor): Promise<ProfileView> {
  const record = await deps.profileRepository.ensure(actor.userId, createDefaultProfile());
  assertProfileOwnedByActor(actor, record);
  return toProfileView(record);
}
