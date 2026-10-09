export type { Actor, ProfileRecord, ProfileRepositoryPort, ProfileView } from "./ports";

export { ProfileNotFoundError } from "./errors";
export { assertProfileOwnedByActor } from "./profile-policy";

export { getMyProfile } from "./get-my-profile";
export type { GetMyProfileDeps } from "./get-my-profile";

export { updateMyProfile } from "./update-my-profile";
export type { UpdateMyProfileDeps } from "./update-my-profile";

export { InvalidProfileError, hasCompletedOnboarding } from "@habit-app/domain";
