import { createDefaultProfile, validateProfileChanges } from "@habit-app/domain";
import type { ProfileChangesInput } from "@habit-app/domain";
import { assertProfileOwnedByActor, toProfileView } from "./profile-policy";
import type { Actor, ProfileRepositoryPort, ProfileView } from "./ports";

export interface UpdateMyProfileDeps {
  readonly profileRepository: ProfileRepositoryPort;
}

/**
 * 自分のプロフィールを部分更新する(PROF-002)。指定項目のみ検証・正規化して更新する。
 * プロフィール未作成の場合は既定値で作成した上で更新する。
 *
 * @throws {InvalidProfileError} 入力が PROF-003〜005 を満たさない場合(永続化は行わない)
 * @throws {ProfileNotFoundError} actor の user が存在しない場合
 */
export async function updateMyProfile(
  deps: UpdateMyProfileDeps,
  actor: Actor,
  input: ProfileChangesInput,
): Promise<ProfileView> {
  const changes = validateProfileChanges(input);

  const existing = await deps.profileRepository.ensure(actor.userId, createDefaultProfile());
  assertProfileOwnedByActor(actor, existing);

  const updated = await deps.profileRepository.update(actor.userId, changes);
  assertProfileOwnedByActor(actor, updated);
  return toProfileView(updated);
}
