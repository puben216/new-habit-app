import { describe, expect, it } from "vitest";
import {
  archiveHabit,
  changeSchedule,
  createHabit,
  findScheduleVersionForDate,
  updateHabitDetails,
} from "./habit";
import type { CreateHabitInput } from "./habit";
import {
  HabitArchivedError,
  InvalidHabitDetailsError,
  InvalidHabitKindError,
  UnsupportedScheduleChangeError,
} from "./errors";

function baseBuildInput(overrides: Partial<CreateHabitInput> = {}): CreateHabitInput {
  return {
    id: "habit-1",
    kind: "build",
    name: "水を飲む",
    purpose: "健康維持",
    cue: "起床直後",
    minimumAction: "コップ1杯の水を飲む",
    initialSchedule: {
      effectiveFrom: "2024-01-01",
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      targetCount: 3,
    },
    ...overrides,
  };
}

describe("createHabit", () => {
  it("buildのHabitを作成できる", () => {
    const habit = createHabit(baseBuildInput());

    expect(habit.kind).toBe("build");
    expect(habit.status).toBe("active");
    expect(habit.replacementAction).toBeNull();
    expect(habit.scheduleVersions).toHaveLength(1);
    expect(habit.scheduleVersions[0]?.targetCount).toBe(3);
  });

  it("reduceのHabitを作成でき、targetCountは1に固定される", () => {
    const habit = createHabit(
      baseBuildInput({
        kind: "reduce",
        name: "間食をやめる",
        initialSchedule: {
          effectiveFrom: "2024-01-01",
          daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
          targetCount: 1,
        },
      }),
    );

    expect(habit.kind).toBe("reduce");
    expect(habit.scheduleVersions[0]?.targetCount).toBe(1);
  });

  it("reduceでtargetCountが1以外の初期スケジュールを拒否する", () => {
    expect(() =>
      createHabit(
        baseBuildInput({
          kind: "reduce",
          initialSchedule: {
            effectiveFrom: "2024-01-01",
            daysOfWeek: [0],
            targetCount: 2,
          },
        }),
      ),
    ).toThrow(/reduce/);
  });

  it("不正なkindを拒否する", () => {
    expect(() =>
      createHabit(
        baseBuildInput({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          kind: "maintain" as any,
        }),
      ),
    ).toThrow(InvalidHabitKindError);
  });

  it("nameが空文字の場合は拒否する", () => {
    expect(() => createHabit(baseBuildInput({ name: "   " }))).toThrow(InvalidHabitDetailsError);
  });

  it("idが空文字の場合は拒否する", () => {
    expect(() => createHabit(baseBuildInput({ id: "" }))).toThrow(InvalidHabitDetailsError);
  });

  it("生成されたHabitはfreezeされ、kindを直接書き換えられない", () => {
    const habit = createHabit(baseBuildInput());

    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (habit as any).kind = "reduce";
    }).toThrow();
    expect(habit.kind).toBe("build");
  });
});

describe("updateHabitDetails", () => {
  it("kindを含まない項目のみ更新できる", () => {
    const habit = createHabit(baseBuildInput());
    const updated = updateHabitDetails(habit, { name: "水をしっかり飲む" });

    expect(updated.name).toBe("水をしっかり飲む");
    expect(updated.kind).toBe("build");
    // 元のオブジェクトは変更されない(イミュータブル)
    expect(habit.name).toBe("水を飲む");
  });

  it("UpdateHabitDetailsInputの型にkindフィールドが存在しないことでコンパイル時に更新不可を強制する", () => {
    const habit = createHabit(baseBuildInput());
    // @ts-expect-error kind は更新できないため型エラーになる
    updateHabitDetails(habit, { kind: "reduce" });
    expect(habit.kind).toBe("build");
  });

  it("アーカイブ済みHabitの更新は拒否する", () => {
    const habit = archiveHabit(createHabit(baseBuildInput()));
    expect(() => updateHabitDetails(habit, { name: "new" })).toThrow(HabitArchivedError);
  });

  it("replacementActionをnullに戻せる", () => {
    const habit = createHabit(baseBuildInput({ replacementAction: "深呼吸をする" }));
    expect(habit.replacementAction).toBe("深呼吸をする");

    const updated = updateHabitDetails(habit, { replacementAction: null });
    expect(updated.replacementAction).toBeNull();
  });
});

describe("archiveHabit", () => {
  it("statusをarchivedにする", () => {
    const habit = createHabit(baseBuildInput());
    const archived = archiveHabit(habit);

    expect(archived.status).toBe("archived");
    expect(habit.status).toBe("active");
  });

  it("既にarchivedな場合は同じ内容を返す(冪等)", () => {
    const habit = archiveHabit(createHabit(baseBuildInput()));
    const archivedAgain = archiveHabit(habit);

    expect(archivedAgain.status).toBe("archived");
  });
});

describe("changeSchedule", () => {
  it("新しい有効開始日からのスケジュールを追加し、既存版のeffectiveFromは変更せずeffectiveToだけを閉じる", () => {
    const habit = createHabit(baseBuildInput());
    const originalFirstVersion = habit.scheduleVersions[0];

    const updated = changeSchedule(habit, {
      effectiveFrom: "2024-04-01",
      daysOfWeek: [1, 3, 5],
      targetCount: 1,
    });

    expect(updated.scheduleVersions).toHaveLength(2);
    const [closedFirst, second] = updated.scheduleVersions;

    // 過去集計を書き換えないよう、既存版のeffectiveFromは保持される
    expect(closedFirst?.effectiveFrom).toBe(originalFirstVersion?.effectiveFrom);
    expect(closedFirst?.effectiveTo).toBe("2024-03-31");
    expect(closedFirst?.targetCount).toBe(originalFirstVersion?.targetCount);

    expect(second?.effectiveFrom).toBe("2024-04-01");
    expect(second?.targetCount).toBe(1);

    // 元のHabitオブジェクトは変更されない
    expect(habit.scheduleVersions).toHaveLength(1);
    expect(habit.scheduleVersions[0]?.effectiveTo).toBeNull();
  });

  it("既存版のeffectiveFrom以前を新しいeffectiveFromに指定する遡及編集は拒否する", () => {
    const habit = createHabit(
      baseBuildInput({
        initialSchedule: { effectiveFrom: "2024-06-01", daysOfWeek: [0], targetCount: 1 },
      }),
    );

    expect(() =>
      changeSchedule(habit, {
        effectiveFrom: "2024-01-01",
        daysOfWeek: [0],
        targetCount: 2,
      }),
    ).toThrow(UnsupportedScheduleChangeError);
  });

  it("既存版と同じeffectiveFromを指定する編集は拒否する", () => {
    const habit = createHabit(baseBuildInput());
    const firstVersion = habit.scheduleVersions[0];
    if (firstVersion === undefined) {
      throw new Error("テストの前提が崩れています: 初期scheduleVersionが存在しません。");
    }

    expect(() =>
      changeSchedule(habit, {
        effectiveFrom: firstVersion.effectiveFrom,
        daysOfWeek: [0],
        targetCount: 2,
      }),
    ).toThrow(UnsupportedScheduleChangeError);
  });

  it("reduceのHabitでtargetCountが1以外のスケジュール変更は拒否する", () => {
    const habit = createHabit(
      baseBuildInput({
        kind: "reduce",
        initialSchedule: { effectiveFrom: "2024-01-01", daysOfWeek: [0], targetCount: 1 },
      }),
    );

    expect(() =>
      changeSchedule(habit, {
        effectiveFrom: "2024-04-01",
        daysOfWeek: [0],
        targetCount: 2,
      }),
    ).toThrow(/reduce/);
  });

  it("アーカイブ済みHabitのスケジュール変更は拒否する", () => {
    const habit = archiveHabit(createHabit(baseBuildInput()));

    expect(() =>
      changeSchedule(habit, {
        effectiveFrom: "2024-04-01",
        daysOfWeek: [0],
        targetCount: 1,
      }),
    ).toThrow(HabitArchivedError);
  });
});

describe("findScheduleVersionForDate", () => {
  it("有効期間内の日付に対応するScheduleVersionを返す", () => {
    let habit = createHabit(baseBuildInput());
    habit = changeSchedule(habit, {
      effectiveFrom: "2024-04-01",
      daysOfWeek: [1, 3, 5],
      targetCount: 1,
    });

    expect(findScheduleVersionForDate(habit, "2024-02-15")?.targetCount).toBe(3);
    expect(findScheduleVersionForDate(habit, "2024-05-01")?.targetCount).toBe(1);
  });

  it("どの版の有効期間にも含まれない日付はnullを返す", () => {
    const habit = createHabit(
      baseBuildInput({
        initialSchedule: {
          effectiveFrom: "2024-06-01",
          effectiveTo: "2024-06-30",
          daysOfWeek: [0],
          targetCount: 1,
        },
      }),
    );

    expect(findScheduleVersionForDate(habit, "2024-01-01")).toBeNull();
    expect(findScheduleVersionForDate(habit, "2024-07-01")).toBeNull();
  });
});
