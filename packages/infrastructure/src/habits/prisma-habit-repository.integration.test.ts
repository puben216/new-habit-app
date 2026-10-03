import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  HabitNotFoundError,
  HabitVersionConflictError,
  InvalidCursorError,
  archiveHabitUseCase,
  createHabitUseCase,
  getHabitUseCase,
  listHabitsUseCase,
  updateHabitUseCase,
} from "@habit-app/application";
import type { CreateHabitUseCaseInput, HabitRecord } from "@habit-app/application";
import { createHabit } from "@habit-app/domain";
import { startPostgresContainer } from "@habit-app/test-support";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient, type PrismaClient } from "../database/prisma-client";
import { createPrismaHabitRepository } from "./prisma-habit-repository";
import { createUuidGenerator } from "./uuid-generator";

import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const infrastructureRoot = path.resolve(__dirname, "../../");
const prismaConfigPath = path.join(infrastructureRoot, "prisma.config.ts");
const prismaCli = path.join(infrastructureRoot, "node_modules", ".bin", "prisma");

const BASE_TIME = Date.parse("2026-10-01T00:00:00.000Z");

describe("PrismaHabitRepository(T-104)", () => {
  let container: StartedPostgreSqlContainer;
  let prisma: PrismaClient;
  let repository: ReturnType<typeof createPrismaHabitRepository>;
  let userA: string;
  let userB: string;
  let clockTick = 0;

  // 呼び出しごとに 1 秒進む Clock(created_at を一意にする)。
  const tickingNow = (): Date => new Date(BASE_TIME + (clockTick += 1) * 1000);
  const deps = () => ({
    habitRepository: repository,
    idGenerator: createUuidGenerator(),
    now: tickingNow,
  });

  function buildInput(
    actorUserId: string,
    overrides: Partial<CreateHabitUseCaseInput> = {},
  ): CreateHabitUseCaseInput {
    return {
      actorUserId,
      kind: "build",
      name: "水を飲む",
      purpose: "健康維持",
      cue: "起床直後",
      minimumAction: "コップ1杯",
      schedule: { effectiveFrom: "2026-10-01", daysOfWeek: [1, 3, 5], targetCount: 2 },
      ...overrides,
    };
  }

  async function createUser(label: string): Promise<string> {
    const user = await prisma.user.create({
      data: {
        authSubject: `credentials:${label}@example.com`,
        emailNormalized: `${label}@example.com`,
        passwordHash: "hash",
      },
    });
    return user.id.toString();
  }

  beforeAll(async () => {
    container = await startPostgresContainer();

    execFileSync(prismaCli, ["migrate", "deploy", "--config", prismaConfigPath], {
      cwd: infrastructureRoot,
      env: { ...process.env, DATABASE_URL: container.getConnectionUri() },
      stdio: "pipe",
    });

    prisma = createPrismaClient(container.getConnectionUri());
    repository = createPrismaHabitRepository(prisma);
    userA = await createUser("habit-user-a");
    userB = await createUser("habit-user-b");
  }, 120_000);

  afterAll(async () => {
    await prisma.$disconnect();
    await container.stop();
  });

  describe("作成と取得(HAPI-001, HAPI-003)", () => {
    it("作成した習慣をそのまま取得でき、version=1・createdAtはClockの値", async () => {
      const created = await createHabitUseCase(deps(), buildInput(userA));

      expect(created.version).toBe(1);
      expect(created.habit.status).toBe("active");

      const found = await getHabitUseCase(deps(), {
        actorUserId: userA,
        habitId: created.habit.id,
      });
      expect(found.habit).toEqual(created.habit);
      expect(found.createdAt).toEqual(created.createdAt);
      expect(found.habit.scheduleVersions).toEqual([
        { effectiveFrom: "2026-10-01", effectiveTo: null, daysOfWeek: [1, 3, 5], targetCount: 2 },
      ]);
    });

    it("reduce習慣とreplacementActionを永続化できる", async () => {
      const created = await createHabitUseCase(
        deps(),
        buildInput(userA, {
          kind: "reduce",
          name: "夜のスナックを減らす",
          replacementAction: "ハーブティーを飲む",
          schedule: { effectiveFrom: "2026-10-01", daysOfWeek: [0, 6], targetCount: 1 },
        }),
      );
      const found = await getHabitUseCase(deps(), {
        actorUserId: userA,
        habitId: created.habit.id,
      });
      expect(found.habit.kind).toBe("reduce");
      expect(found.habit.replacementAction).toBe("ハーブティーを飲む");
    });

    it("UUID形式でないidはNotFound(DBエラーにならない)", async () => {
      await expect(
        getHabitUseCase(deps(), { actorUserId: userA, habitId: "not-a-uuid" }),
      ).rejects.toThrow(HabitNotFoundError);
    });
  });

  describe("DB constraint(HAPI-INV-003: 最終防衛線)", () => {
    async function insertHabit(): Promise<bigint> {
      const created = await createHabitUseCase(deps(), buildInput(userA));
      const row = await prisma.habit.findFirstOrThrow({ where: { publicId: created.habit.id } });
      return row.id;
    }

    it("同一habitで有効期間が重複するScheduleVersionをDBが拒否する(exclusion constraint)", async () => {
      const habitId = await insertHabit();
      await expect(
        prisma.habitScheduleVersion.create({
          data: {
            habitId,
            effectiveFrom: new Date("2026-12-01T00:00:00Z"),
            daysOfWeek: [1],
            targetCount: 1,
          },
        }),
      ).rejects.toThrow();
    });

    it("(habit_id, effective_from)の重複をDBが拒否する", async () => {
      const habitId = await insertHabit();
      await expect(
        prisma.habitScheduleVersion.create({
          data: {
            habitId,
            effectiveFrom: new Date("2026-10-01T00:00:00Z"),
            effectiveTo: new Date("2026-10-31T00:00:00Z"),
            daysOfWeek: [1],
            targetCount: 1,
          },
        }),
      ).rejects.toThrow();
    });

    it("daysOfWeekの範囲外/空配列、targetCount<=0をDBが拒否する(CHECK)", async () => {
      const habitId = await insertHabit();
      const base = { habitId, effectiveFrom: new Date("2027-01-01T00:00:00Z") };
      await expect(
        prisma.habitScheduleVersion.create({ data: { ...base, daysOfWeek: [7], targetCount: 1 } }),
      ).rejects.toThrow();
      await expect(
        prisma.habitScheduleVersion.create({ data: { ...base, daysOfWeek: [], targetCount: 1 } }),
      ).rejects.toThrow();
      await expect(
        prisma.habitScheduleVersion.create({ data: { ...base, daysOfWeek: [1], targetCount: 0 } }),
      ).rejects.toThrow();
    });

    it("不正なkind/statusをDBが拒否する(CHECK)", async () => {
      const base = {
        userId: BigInt(userA),
        name: "n",
        purpose: "p",
        cue: "c",
        minimumAction: "m",
      };
      await expect(prisma.habit.create({ data: { ...base, kind: "other" } })).rejects.toThrow();
      await expect(
        prisma.habit.create({ data: { ...base, kind: "build", status: "deleted" } }),
      ).rejects.toThrow();
    });

    it("存在しないユーザーの習慣作成はFK違反で失敗し、部分的な行を残さない", async () => {
      const before = await prisma.habit.count();
      const habit = createHabit({
        id: "11111111-1111-4111-8111-111111111111",
        kind: "build",
        name: "n",
        purpose: "p",
        cue: "c",
        minimumAction: "m",
        initialSchedule: { effectiveFrom: "2026-10-01", daysOfWeek: [1], targetCount: 1 },
      });
      await expect(
        repository.create({ actorUserId: "999999", habit, now: new Date(BASE_TIME) }),
      ).rejects.toThrow();
      expect(await prisma.habit.count()).toBe(before);
    });
  });

  describe("IDOR(HAPI-INV-001)", () => {
    it("他ユーザーは取得・更新・アーカイブのいずれもできず、元の習慣は変わらない", async () => {
      const created = await createHabitUseCase(deps(), buildInput(userA, { name: "Aの習慣" }));
      const habitId = created.habit.id;

      await expect(getHabitUseCase(deps(), { actorUserId: userB, habitId })).rejects.toThrow(
        HabitNotFoundError,
      );
      await expect(
        updateHabitUseCase(deps(), {
          actorUserId: userB,
          habitId,
          version: 1,
          details: { name: "乗っ取り" },
        }),
      ).rejects.toThrow(HabitNotFoundError);
      await expect(
        archiveHabitUseCase(deps(), { actorUserId: userB, habitId, version: 1 }),
      ).rejects.toThrow(HabitNotFoundError);

      // repository を直接呼んでも到達できない(use case の事前チェックに依存しない)。
      expect(
        await repository.save({
          actorUserId: userB,
          habit: created.habit,
          expectedVersion: 1,
          now: new Date(BASE_TIME),
        }),
      ).toEqual({ status: "not_found" });

      const after = await getHabitUseCase(deps(), { actorUserId: userA, habitId });
      expect(after.habit.name).toBe("Aの習慣");
      expect(after.habit.status).toBe("active");
      expect(after.version).toBe(1);
    });

    it("一覧に他ユーザーの習慣が含まれず、他ユーザーの習慣を指すcursorは無効", async () => {
      const aHabit = await createHabitUseCase(deps(), buildInput(userA, { name: "A専用" }));
      const bHabit = await createHabitUseCase(deps(), buildInput(userB, { name: "B専用" }));

      const bList = await listHabitsUseCase(deps(), {
        actorUserId: userB,
        status: "active",
        limit: 100,
      });
      expect(bList.items.map((r) => r.habit.id)).toContain(bHabit.habit.id);
      expect(bList.items.map((r) => r.habit.id)).not.toContain(aHabit.habit.id);

      // Aの習慣から作った cursor を B が使っても、B の一覧位置としては解決できない。
      const aPage = await listHabitsUseCase(deps(), {
        actorUserId: userA,
        status: "active",
        limit: 1,
      });
      expect(aPage.nextCursor).not.toBeNull();
      await expect(
        listHabitsUseCase(deps(), {
          actorUserId: userB,
          status: "active",
          limit: 10,
          cursor: aPage.nextCursor ?? "",
        }),
      ).rejects.toThrow(InvalidCursorError);
    });

    it("形式不正のactor user IDは何にも到達できない", async () => {
      const created = await createHabitUseCase(deps(), buildInput(userA));
      for (const actor of ["", "abc", "0", "-1", "1; DROP TABLE habits", "99999999999999999999"]) {
        expect(
          await repository.findById({ actorUserId: actor, habitId: created.habit.id }),
        ).toBeNull();
        expect(
          await repository.list({
            actorUserId: actor,
            status: "active",
            limit: 10,
            afterHabitId: null,
          }),
        ).toEqual({ ok: true, items: [] });
      }
    });
  });

  describe("更新・楽観ロック(HAPI-004, HAPI-005, HAPI-INV-002)", () => {
    it("詳細更新でversionが1増え、更新内容が永続化される", async () => {
      const created = await createHabitUseCase(deps(), buildInput(userA));
      const updated = await updateHabitUseCase(deps(), {
        actorUserId: userA,
        habitId: created.habit.id,
        version: 1,
        details: { name: "新しい名前", replacementAction: "代替行動" },
      });
      expect(updated.version).toBe(2);

      const found = await getHabitUseCase(deps(), {
        actorUserId: userA,
        habitId: created.habit.id,
      });
      expect(found.habit.name).toBe("新しい名前");
      expect(found.habit.replacementAction).toBe("代替行動");
      expect(found.version).toBe(2);
    });

    it("古いversionでの更新・アーカイブは409相当(Conflict)で、内容は変わらない", async () => {
      const created = await createHabitUseCase(deps(), buildInput(userA, { name: "元の名前" }));
      await updateHabitUseCase(deps(), {
        actorUserId: userA,
        habitId: created.habit.id,
        version: 1,
        details: { name: "更新1" },
      });

      await expect(
        updateHabitUseCase(deps(), {
          actorUserId: userA,
          habitId: created.habit.id,
          version: 1,
          details: { name: "古いversionからの更新" },
        }),
      ).rejects.toThrow(HabitVersionConflictError);
      await expect(
        archiveHabitUseCase(deps(), {
          actorUserId: userA,
          habitId: created.habit.id,
          version: 1,
        }),
      ).rejects.toThrow(HabitVersionConflictError);

      const found = await getHabitUseCase(deps(), {
        actorUserId: userA,
        habitId: created.habit.id,
      });
      expect(found.habit.name).toBe("更新1");
      expect(found.habit.status).toBe("active");
      expect(found.version).toBe(2);
    });

    it("同一versionの並行更新は1件だけ成功し、残りはConflictになる", async () => {
      const created = await createHabitUseCase(deps(), buildInput(userA));
      const attempts = 8;

      const results = await Promise.allSettled(
        Array.from({ length: attempts }, (_, i) =>
          updateHabitUseCase(deps(), {
            actorUserId: userA,
            habitId: created.habit.id,
            version: 1,
            details: { name: `並行更新${i}` },
          }),
        ),
      );

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(attempts - 1);
      for (const r of rejected) {
        expect(r.reason).toBeInstanceOf(HabitVersionConflictError);
      }

      const found = await getHabitUseCase(deps(), {
        actorUserId: userA,
        habitId: created.habit.id,
      });
      expect(found.version).toBe(2);
    });

    it("repository.saveの並行呼び出しもversionが同じなら1件だけsavedになる", async () => {
      const created = await createHabitUseCase(deps(), buildInput(userA));
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          repository.save({
            actorUserId: userA,
            habit: { ...created.habit, name: `直接save${i}` },
            expectedVersion: 1,
            now: new Date(BASE_TIME),
          }),
        ),
      );
      expect(results.filter((r) => r.status === "saved")).toHaveLength(1);
      expect(results.filter((r) => r.status === "conflict")).toHaveLength(5);
    });

    it("スケジュール変更は既存版のeffectiveFromを保持してeffectiveToを閉じ、新版を追加する", async () => {
      const created = await createHabitUseCase(deps(), buildInput(userA));
      const updated = await updateHabitUseCase(deps(), {
        actorUserId: userA,
        habitId: created.habit.id,
        version: 1,
        schedule: { effectiveFrom: "2026-11-01", daysOfWeek: [2, 4], targetCount: 3 },
      });
      expect(updated.version).toBe(2);

      const found = await getHabitUseCase(deps(), {
        actorUserId: userA,
        habitId: created.habit.id,
      });
      expect(found.habit.scheduleVersions).toEqual([
        {
          effectiveFrom: "2026-10-01",
          effectiveTo: "2026-10-31",
          daysOfWeek: [1, 3, 5],
          targetCount: 2,
        },
        { effectiveFrom: "2026-11-01", effectiveTo: null, daysOfWeek: [2, 4], targetCount: 3 },
      ]);

      // さらに変更しても履歴が積み上がる(既存の版は書き換えられない)。
      await updateHabitUseCase(deps(), {
        actorUserId: userA,
        habitId: created.habit.id,
        version: 2,
        schedule: { effectiveFrom: "2026-12-15", daysOfWeek: [0], targetCount: 1 },
      });
      const again = await getHabitUseCase(deps(), {
        actorUserId: userA,
        habitId: created.habit.id,
      });
      expect(again.habit.scheduleVersions.map((v) => [v.effectiveFrom, v.effectiveTo])).toEqual([
        ["2026-10-01", "2026-10-31"],
        ["2026-11-01", "2026-12-14"],
        ["2026-12-15", null],
      ]);
    });

    it("並行したスケジュール変更の敗者はスケジュールを部分的にも変更しない(原子性)", async () => {
      const created = await createHabitUseCase(deps(), buildInput(userA));
      const results = await Promise.allSettled(
        ["2026-11-01", "2026-12-01", "2027-01-01", "2027-02-01"].map((effectiveFrom) =>
          updateHabitUseCase(deps(), {
            actorUserId: userA,
            habitId: created.habit.id,
            version: 1,
            schedule: { effectiveFrom, daysOfWeek: [1], targetCount: 1 },
          }),
        ),
      );
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);

      const found = await getHabitUseCase(deps(), {
        actorUserId: userA,
        habitId: created.habit.id,
      });
      // 勝者の 1 版だけが追加され、既存版はちょうど 1 回だけ閉じられている。
      expect(found.habit.scheduleVersions).toHaveLength(2);
      expect(found.habit.scheduleVersions[0]?.effectiveTo).not.toBeNull();
      expect(found.habit.scheduleVersions[1]?.effectiveTo).toBeNull();
      expect(found.version).toBe(2);
    });

    it("アーカイブが永続化され、再実行は冪等でversionを増やさない", async () => {
      const created = await createHabitUseCase(deps(), buildInput(userA));
      const archived = await archiveHabitUseCase(deps(), {
        actorUserId: userA,
        habitId: created.habit.id,
        version: 1,
      });
      expect(archived.habit.status).toBe("archived");
      expect(archived.version).toBe(2);

      const again = await archiveHabitUseCase(deps(), {
        actorUserId: userA,
        habitId: created.habit.id,
        version: 1,
      });
      expect(again.version).toBe(2);

      const found = await getHabitUseCase(deps(), {
        actorUserId: userA,
        habitId: created.habit.id,
      });
      expect(found.habit.status).toBe("archived");
    });
  });

  describe("pagination(HAPI-002, HAPI-INV-004)", () => {
    let paginationUser: string;
    const createdIds: string[] = [];

    beforeAll(async () => {
      paginationUser = await createUser("habit-pagination");
      // 25 件。5 件ずつ同一の created_at(同時刻の並びが id で決定的になることを検証する)。
      for (let i = 0; i < 25; i += 1) {
        const created: HabitRecord = await createHabitUseCase(
          {
            habitRepository: repository,
            idGenerator: createUuidGenerator(),
            now: () => new Date(BASE_TIME + 10_000_000 + Math.floor(i / 5) * 1000),
          },
          buildInput(paginationUser, { name: `ページ${i}` }),
        );
        createdIds.push(created.habit.id);
      }
    }, 60_000);

    async function collectAll(
      actorUserId: string,
      status: "active" | "archived",
      limit: number,
    ): Promise<string[][]> {
      const pages: string[][] = [];
      let cursor: string | undefined;
      for (let guard = 0; guard < 50; guard += 1) {
        const page = await listHabitsUseCase(deps(), { actorUserId, status, limit, cursor });
        pages.push(page.items.map((r) => r.habit.id));
        if (page.nextCursor === null) return pages;
        cursor = page.nextCursor;
      }
      throw new Error("pagination did not terminate");
    }

    it("全ページを辿ると重複・欠落なく、(created_at desc, id desc)の順で全件が得られる", async () => {
      const pages = await collectAll(paginationUser, "active", 10);
      expect(pages.map((p) => p.length)).toEqual([10, 10, 5]);

      const all = pages.flat();
      expect(new Set(all).size).toBe(25);
      expect(new Set(all)).toEqual(new Set(createdIds));

      const expected = await prisma.habit.findMany({
        where: { userId: BigInt(paginationUser) },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: { publicId: true },
      });
      expect(all).toEqual(expected.map((r) => r.publicId));
    });

    it("ちょうどlimit件で割り切れる場合、最後のnextCursorはnullで空ページを返さない", async () => {
      const pages = await collectAll(paginationUser, "active", 5);
      expect(pages.map((p) => p.length)).toEqual([5, 5, 5, 5, 5]);
    });

    it("limitが件数より大きい場合は1ページでnextCursorはnull、空状態は空配列", async () => {
      const page = await listHabitsUseCase(deps(), {
        actorUserId: paginationUser,
        status: "active",
        limit: 100,
      });
      expect(page.items).toHaveLength(25);
      expect(page.nextCursor).toBeNull();

      const emptyUser = await createUser("habit-empty");
      expect(
        await listHabitsUseCase(deps(), { actorUserId: emptyUser, status: "active", limit: 20 }),
      ).toEqual({ items: [], nextCursor: null });
    });

    it("statusで絞り込める(アーカイブした習慣はarchivedの一覧にだけ現れる)", async () => {
      const targets = createdIds.slice(0, 3);
      for (const habitId of targets) {
        await archiveHabitUseCase(deps(), { actorUserId: paginationUser, habitId, version: 1 });
      }

      const active = (await collectAll(paginationUser, "active", 10)).flat();
      const archived = (await collectAll(paginationUser, "archived", 10)).flat();
      expect(active).toHaveLength(22);
      expect(archived.sort()).toEqual([...targets].sort());
      expect(active.some((id) => targets.includes(id))).toBe(false);
    });

    it("ページ送りの途中でcursorが指す習慣がアーカイブされても、続きを取得できる", async () => {
      const first = await listHabitsUseCase(deps(), {
        actorUserId: paginationUser,
        status: "active",
        limit: 5,
      });
      const last = first.items[first.items.length - 1];
      if (last === undefined) throw new Error("unexpected empty page");
      await archiveHabitUseCase(deps(), {
        actorUserId: paginationUser,
        habitId: last.habit.id,
        version: last.version,
      });

      const second = await listHabitsUseCase(deps(), {
        actorUserId: paginationUser,
        status: "active",
        limit: 5,
        cursor: first.nextCursor ?? "",
      });
      expect(second.items).toHaveLength(5);
      expect(second.items.map((r) => r.habit.id)).not.toContain(last.habit.id);
    });
  });
});
