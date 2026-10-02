import { InvalidProfileError } from "@habit-app/domain";
import { describe, expect, it } from "vitest";
import { ProfileNotFoundError } from "./errors";
import { getMyProfile } from "./get-my-profile";
import { assertProfileOwnedByActor } from "./profile-policy";
import { createFakeProfileRepository } from "./test-fakes";
import { updateMyProfile } from "./update-my-profile";
import type { ProfileRecord } from "./ports";

const actorA = { userId: "1" };
const actorB = { userId: "2" };
const updatedAt = new Date("2026-10-02T00:00:00.000Z");

function recordFor(userId: string, overrides: Partial<ProfileRecord> = {}): ProfileRecord {
  return {
    userId,
    displayName: "架空ユーザー",
    timezone: "Asia/Tokyo",
    locale: "ja",
    weekStartsOn: 1,
    updatedAt,
    ...overrides,
  };
}

describe("getMyProfile(PROF-001/006)", () => {
  it("未作成なら既定値で作成して返す(内部IDは含めない)", async () => {
    const profileRepository = createFakeProfileRepository(["1"]);

    const view = await getMyProfile({ profileRepository }, actorA);

    expect(view).toEqual({
      displayName: null,
      timezone: "Asia/Tokyo",
      locale: "ja",
      weekStartsOn: 1,
      updatedAt,
    });
    expect(view).not.toHaveProperty("userId");
    expect(profileRepository.profiles.has("1")).toBe(true);
  });

  it("作成済みなら既存の値を返し、上書きしない", async () => {
    const profileRepository = createFakeProfileRepository([]);
    profileRepository.seed(recordFor("1", { displayName: "既存", timezone: "America/New_York" }));

    const view = await getMyProfile({ profileRepository }, actorA);

    expect(view.displayName).toBe("既存");
    expect(view.timezone).toBe("America/New_York");
  });

  it("user が存在しない場合は ProfileNotFoundError", async () => {
    const profileRepository = createFakeProfileRepository([]);

    await expect(getMyProfile({ profileRepository }, actorA)).rejects.toBeInstanceOf(
      ProfileNotFoundError,
    );
  });

  it("他ユーザーの行は返さない(actor の行のみ)", async () => {
    const profileRepository = createFakeProfileRepository(["1"]);
    profileRepository.seed(recordFor("2", { displayName: "他人" }));

    const view = await getMyProfile({ profileRepository }, actorA);

    expect(view.displayName).toBeNull();
  });
});

describe("updateMyProfile(PROF-002)", () => {
  it("指定項目のみ更新し、他の項目は変更しない", async () => {
    const profileRepository = createFakeProfileRepository([]);
    profileRepository.seed(recordFor("1", { locale: "en", weekStartsOn: 0 }));

    const view = await updateMyProfile({ profileRepository }, actorA, {
      displayName: "  たなか  ",
      timezone: "America/New_York",
    });

    expect(view).toMatchObject({
      displayName: "たなか",
      timezone: "America/New_York",
      locale: "en",
      weekStartsOn: 0,
    });
  });

  it("未作成でも既定値で作成した上で更新できる", async () => {
    const profileRepository = createFakeProfileRepository(["1"]);

    const view = await updateMyProfile({ profileRepository }, actorA, { displayName: "初回" });

    expect(view).toMatchObject({ displayName: "初回", timezone: "Asia/Tokyo", locale: "ja" });
  });

  it("同じ値での更新も成功する(冪等)", async () => {
    const profileRepository = createFakeProfileRepository([]);
    profileRepository.seed(recordFor("1"));

    const first = await updateMyProfile({ profileRepository }, actorA, { timezone: "Asia/Tokyo" });
    const second = await updateMyProfile({ profileRepository }, actorA, { timezone: "Asia/Tokyo" });

    expect(second).toEqual(first);
  });

  it("入力が不正なら InvalidProfileError で、永続化しない", async () => {
    const profileRepository = createFakeProfileRepository(["1"]);

    await expect(
      updateMyProfile({ profileRepository }, actorA, { timezone: "JST" }),
    ).rejects.toBeInstanceOf(InvalidProfileError);
    expect(profileRepository.profiles.size).toBe(0);
  });

  it("user が存在しない場合は ProfileNotFoundError", async () => {
    const profileRepository = createFakeProfileRepository([]);

    await expect(
      updateMyProfile({ profileRepository }, actorA, { displayName: "a" }),
    ).rejects.toBeInstanceOf(ProfileNotFoundError);
  });

  it("他ユーザーの行を変更しない(PROF-007)", async () => {
    const profileRepository = createFakeProfileRepository([]);
    profileRepository.seed(recordFor("1"));
    profileRepository.seed(recordFor("2", { displayName: "他人" }));

    await updateMyProfile({ profileRepository }, actorA, { displayName: "自分" });

    expect(profileRepository.profiles.get("2")?.displayName).toBe("他人");
    expect(profileRepository.profiles.get("1")?.displayName).toBe("自分");
  });
});

describe("assertProfileOwnedByActor(PROF-007)", () => {
  it("所有者が一致すれば通す", () => {
    expect(() => assertProfileOwnedByActor(actorA, recordFor("1"))).not.toThrow();
  });

  it("null は ProfileNotFoundError", () => {
    expect(() => assertProfileOwnedByActor(actorA, null)).toThrow(ProfileNotFoundError);
  });

  it("所有者が異なる record は存在を漏らさず ProfileNotFoundError", () => {
    expect(() => assertProfileOwnedByActor(actorB, recordFor("1"))).toThrow(ProfileNotFoundError);
  });
});
