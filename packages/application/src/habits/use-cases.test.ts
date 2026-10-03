import {
  HabitArchivedError,
  InvalidScheduleVersionError,
  UnsupportedScheduleChangeError,
} from "@habit-app/domain";
import { beforeEach, describe, expect, it } from "vitest";

import { encodeHabitCursor } from "./cursor";
import { HabitNotFoundError, HabitVersionConflictError, InvalidCursorError } from "./errors";
import { createFakeHabitRepository, createSequentialIdGenerator } from "./test-fakes";
import type { FakeHabitRepository } from "./test-fakes";
import {
  archiveHabitUseCase,
  createHabitUseCase,
  getHabitUseCase,
  listHabitsUseCase,
  updateHabitUseCase,
} from "./use-cases";
import type { CreateHabitUseCaseInput } from "./use-cases";

const USER_A = "1";
const USER_B = "2";
const NOW = new Date("2026-10-01T00:00:00.000Z");

function buildInput(overrides: Partial<CreateHabitUseCaseInput> = {}): CreateHabitUseCaseInput {
  return {
    actorUserId: USER_A,
    kind: "build",
    name: "水を飲む",
    purpose: "健康維持",
    cue: "起床直後",
    minimumAction: "コップ1杯",
    schedule: { effectiveFrom: "2026-10-01", daysOfWeek: [1, 2, 3], targetCount: 2 },
    ...overrides,
  };
}

describe("habit use cases(HAPI-001〜005)", () => {
  let repo: FakeHabitRepository;
  let deps: {
    habitRepository: FakeHabitRepository;
    idGenerator: ReturnType<typeof createSequentialIdGenerator>;
    now: () => Date;
  };

  beforeEach(() => {
    repo = createFakeHabitRepository();
    deps = { habitRepository: repo, idGenerator: createSequentialIdGenerator(), now: () => NOW };
  });

  describe("createHabitUseCase(HAPI-001)", () => {
    it("Domainで検証した習慣を version=1・active で保存し、採番したIDを使う", async () => {
      const record = await createHabitUseCase(deps, buildInput());

      expect(record.version).toBe(1);
      expect(record.habit.status).toBe("active");
      expect(record.habit.id).toBe("00000000-0000-4000-8000-000000000001");
      expect(record.createdAt).toEqual(NOW);
    });

    it("reduceでtargetCountが1以外ならDomainのエラーを伝播し、保存しない", async () => {
      await expect(
        createHabitUseCase(
          deps,
          buildInput({
            kind: "reduce",
            schedule: { effectiveFrom: "2026-10-01", daysOfWeek: [1], targetCount: 2 },
          }),
        ),
      ).rejects.toThrow(InvalidScheduleVersionError);
      expect(repo.calls).toHaveLength(0);
    });

    it("replacementActionにnullを渡すとnullで保存する", async () => {
      const record = await createHabitUseCase(deps, buildInput({ replacementAction: null }));
      expect(record.habit.replacementAction).toBeNull();
    });
  });

  describe("getHabitUseCase(HAPI-003, HAPI-INV-001)", () => {
    it("自分の習慣を取得できる", async () => {
      const created = await createHabitUseCase(deps, buildInput());
      const found = await getHabitUseCase(deps, { actorUserId: USER_A, habitId: created.habit.id });
      expect(found.habit.id).toBe(created.habit.id);
    });

    it("他ユーザーの習慣・存在しない習慣はどちらもNotFound", async () => {
      const created = await createHabitUseCase(deps, buildInput());
      await expect(
        getHabitUseCase(deps, { actorUserId: USER_B, habitId: created.habit.id }),
      ).rejects.toThrow(HabitNotFoundError);
      await expect(
        getHabitUseCase(deps, {
          actorUserId: USER_A,
          habitId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        }),
      ).rejects.toThrow(HabitNotFoundError);
    });
  });

  describe("listHabitsUseCase(HAPI-002)", () => {
    it("limit件ずつ新しい順に返し、最後のnextCursorはnull", async () => {
      for (let i = 0; i < 5; i += 1) {
        await createHabitUseCase(deps, buildInput({ name: `習慣${i}` }));
      }

      const page1 = await listHabitsUseCase(deps, {
        actorUserId: USER_A,
        status: "active",
        limit: 2,
      });
      expect(page1.items.map((r) => r.habit.name)).toEqual(["習慣4", "習慣3"]);
      expect(page1.nextCursor).not.toBeNull();

      const page2 = await listHabitsUseCase(deps, {
        actorUserId: USER_A,
        status: "active",
        limit: 2,
        cursor: page1.nextCursor ?? "",
      });
      expect(page2.items.map((r) => r.habit.name)).toEqual(["習慣2", "習慣1"]);

      const page3 = await listHabitsUseCase(deps, {
        actorUserId: USER_A,
        status: "active",
        limit: 2,
        cursor: page2.nextCursor ?? "",
      });
      expect(page3.items.map((r) => r.habit.name)).toEqual(["習慣0"]);
      expect(page3.nextCursor).toBeNull();
    });

    it("ちょうどlimit件ならnextCursorはnull", async () => {
      await createHabitUseCase(deps, buildInput());
      await createHabitUseCase(deps, buildInput());
      const page = await listHabitsUseCase(deps, {
        actorUserId: USER_A,
        status: "active",
        limit: 2,
      });
      expect(page.items).toHaveLength(2);
      expect(page.nextCursor).toBeNull();
    });

    it("空状態は空配列とnullを返す", async () => {
      const page = await listHabitsUseCase(deps, {
        actorUserId: USER_A,
        status: "active",
        limit: 20,
      });
      expect(page).toEqual({ items: [], nextCursor: null });
    });

    it("他ユーザーの習慣を指すcursorはInvalidCursorError", async () => {
      const mine = await createHabitUseCase(deps, buildInput({ actorUserId: USER_B }));
      const cursor = encodeHabitCursor({ habitId: mine.habit.id, status: "active" });
      await expect(
        listHabitsUseCase(deps, { actorUserId: USER_A, status: "active", limit: 10, cursor }),
      ).rejects.toThrow(InvalidCursorError);
    });

    it("形式不正・status不一致のcursorはInvalidCursorErrorでrepositoryを呼ばない", async () => {
      await expect(
        listHabitsUseCase(deps, { actorUserId: USER_A, status: "active", limit: 10, cursor: "xx" }),
      ).rejects.toThrow(InvalidCursorError);
      const cursor = encodeHabitCursor({
        habitId: "5d1b6d4e-6b1c-4a0e-9e0e-7a0f8d5b8c11",
        status: "archived",
      });
      await expect(
        listHabitsUseCase(deps, { actorUserId: USER_A, status: "active", limit: 10, cursor }),
      ).rejects.toThrow(InvalidCursorError);
      expect(repo.calls).toHaveLength(0);
    });
  });

  describe("updateHabitUseCase(HAPI-004)", () => {
    it("詳細を更新するとversionが1増える", async () => {
      const created = await createHabitUseCase(deps, buildInput());
      const updated = await updateHabitUseCase(deps, {
        actorUserId: USER_A,
        habitId: created.habit.id,
        version: 1,
        details: { name: "新しい名前" },
      });
      expect(updated.version).toBe(2);
      expect(updated.habit.name).toBe("新しい名前");
      expect(updated.habit.purpose).toBe("健康維持");
    });

    it("詳細とスケジュールを同時に更新しても1回の保存(version+1)で、有効開始日が保持される", async () => {
      const created = await createHabitUseCase(deps, buildInput());
      const updated = await updateHabitUseCase(deps, {
        actorUserId: USER_A,
        habitId: created.habit.id,
        version: 1,
        details: { cue: "朝食後" },
        schedule: { effectiveFrom: "2026-11-01", daysOfWeek: [4], targetCount: 1 },
      });
      expect(updated.version).toBe(2);
      expect(updated.habit.scheduleVersions.map((v) => [v.effectiveFrom, v.effectiveTo])).toEqual([
        ["2026-10-01", "2026-10-31"],
        ["2026-11-01", null],
      ]);
      expect(repo.calls.filter((c) => c.method === "save")).toHaveLength(1);
    });

    it("version不一致はConflictで、保存を呼ばない", async () => {
      const created = await createHabitUseCase(deps, buildInput());
      await expect(
        updateHabitUseCase(deps, {
          actorUserId: USER_A,
          habitId: created.habit.id,
          version: 5,
          details: { name: "x" },
        }),
      ).rejects.toThrow(HabitVersionConflictError);
      expect(repo.calls.some((c) => c.method === "save")).toBe(false);
    });

    it("読み込み後の並行更新(saveがconflict)もConflictになる", async () => {
      const created = await createHabitUseCase(deps, buildInput());
      repo.forceConflictOnNextSave();
      await expect(
        updateHabitUseCase(deps, {
          actorUserId: USER_A,
          habitId: created.habit.id,
          version: 1,
          details: { name: "x" },
        }),
      ).rejects.toThrow(HabitVersionConflictError);
    });

    it("他ユーザーの習慣はNotFoundで、内容は変わらない", async () => {
      const created = await createHabitUseCase(deps, buildInput());
      await expect(
        updateHabitUseCase(deps, {
          actorUserId: USER_B,
          habitId: created.habit.id,
          version: 1,
          details: { name: "乗っ取り" },
        }),
      ).rejects.toThrow(HabitNotFoundError);
      const after = await getHabitUseCase(deps, { actorUserId: USER_A, habitId: created.habit.id });
      expect(after.habit.name).toBe("水を飲む");
    });

    it("アーカイブ済みの更新はHabitArchivedError", async () => {
      const created = await createHabitUseCase(deps, buildInput());
      await archiveHabitUseCase(deps, {
        actorUserId: USER_A,
        habitId: created.habit.id,
        version: 1,
      });
      await expect(
        updateHabitUseCase(deps, {
          actorUserId: USER_A,
          habitId: created.habit.id,
          version: 2,
          details: { name: "x" },
        }),
      ).rejects.toThrow(HabitArchivedError);
    });

    it("遡及的なスケジュール変更はDomainのエラーを伝播する", async () => {
      const created = await createHabitUseCase(deps, buildInput());
      await expect(
        updateHabitUseCase(deps, {
          actorUserId: USER_A,
          habitId: created.habit.id,
          version: 1,
          schedule: { effectiveFrom: "2026-09-01", daysOfWeek: [1], targetCount: 1 },
        }),
      ).rejects.toThrow(UnsupportedScheduleChangeError);
    });

    it("変更がなければ保存せず現状を返す", async () => {
      const created = await createHabitUseCase(deps, buildInput());
      const result = await updateHabitUseCase(deps, {
        actorUserId: USER_A,
        habitId: created.habit.id,
        version: 1,
      });
      expect(result.version).toBe(1);
    });
  });

  describe("archiveHabitUseCase(HAPI-005)", () => {
    it("archivedにしてversionが1増える", async () => {
      const created = await createHabitUseCase(deps, buildInput());
      const archived = await archiveHabitUseCase(deps, {
        actorUserId: USER_A,
        habitId: created.habit.id,
        version: 1,
      });
      expect(archived.habit.status).toBe("archived");
      expect(archived.version).toBe(2);
    });

    it("再実行は冪等で、古いversionでもversionを増やさず現状を返す", async () => {
      const created = await createHabitUseCase(deps, buildInput());
      await archiveHabitUseCase(deps, {
        actorUserId: USER_A,
        habitId: created.habit.id,
        version: 1,
      });
      const again = await archiveHabitUseCase(deps, {
        actorUserId: USER_A,
        habitId: created.habit.id,
        version: 1,
      });
      expect(again.habit.status).toBe("archived");
      expect(again.version).toBe(2);
    });

    it("version不一致(active)はConflict、他ユーザーはNotFound", async () => {
      const created = await createHabitUseCase(deps, buildInput());
      await expect(
        archiveHabitUseCase(deps, { actorUserId: USER_A, habitId: created.habit.id, version: 9 }),
      ).rejects.toThrow(HabitVersionConflictError);
      await expect(
        archiveHabitUseCase(deps, { actorUserId: USER_B, habitId: created.habit.id, version: 1 }),
      ).rejects.toThrow(HabitNotFoundError);
    });

    it("アーカイブ済みはstatus=archivedの一覧に現れ、activeの一覧から消える", async () => {
      const created = await createHabitUseCase(deps, buildInput());
      await archiveHabitUseCase(deps, {
        actorUserId: USER_A,
        habitId: created.habit.id,
        version: 1,
      });
      const active = await listHabitsUseCase(deps, {
        actorUserId: USER_A,
        status: "active",
        limit: 10,
      });
      const archived = await listHabitsUseCase(deps, {
        actorUserId: USER_A,
        status: "archived",
        limit: 10,
      });
      expect(active.items).toHaveLength(0);
      expect(archived.items).toHaveLength(1);
    });
  });

  it("すべてのrepository呼び出しにactorUserIdが渡される(HAPI-INV-001)", async () => {
    const created = await createHabitUseCase(deps, buildInput());
    await getHabitUseCase(deps, { actorUserId: USER_A, habitId: created.habit.id });
    await listHabitsUseCase(deps, { actorUserId: USER_A, status: "active", limit: 10 });
    await updateHabitUseCase(deps, {
      actorUserId: USER_A,
      habitId: created.habit.id,
      version: 1,
      details: { name: "x" },
    });
    await archiveHabitUseCase(deps, { actorUserId: USER_A, habitId: created.habit.id, version: 2 });

    expect(repo.calls.length).toBeGreaterThan(0);
    expect(repo.calls.every((c) => c.actorUserId === USER_A)).toBe(true);
  });
});
