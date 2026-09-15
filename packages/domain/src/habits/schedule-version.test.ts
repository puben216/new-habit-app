import { describe, expect, it } from "vitest";
import {
  assertNoOverlappingScheduleVersions,
  closeScheduleVersion,
  createScheduleVersion,
  isTargetMet,
  scheduleVersionsOverlap,
} from "./schedule-version";
import { InvalidScheduleVersionError, OverlappingScheduleVersionError } from "./errors";

describe("createScheduleVersion", () => {
  it("buildで有効な入力からScheduleVersionを生成できる", () => {
    const version = createScheduleVersion("build", {
      effectiveFrom: "2024-01-01",
      effectiveTo: null,
      daysOfWeek: [1, 3, 5],
      targetCount: 3,
    });

    expect(version).toEqual({
      effectiveFrom: "2024-01-01",
      effectiveTo: null,
      daysOfWeek: [1, 3, 5],
      targetCount: 3,
    });
  });

  it("daysOfWeekをソートして正規化する", () => {
    const version = createScheduleVersion("build", {
      effectiveFrom: "2024-01-01",
      daysOfWeek: [5, 0, 3],
      targetCount: 1,
    });

    expect(version.daysOfWeek).toEqual([0, 3, 5]);
  });

  it("effectiveToを省略した場合は無期限(null)になる", () => {
    const version = createScheduleVersion("build", {
      effectiveFrom: "2024-01-01",
      daysOfWeek: [0],
      targetCount: 1,
    });

    expect(version.effectiveTo).toBeNull();
  });

  it("生成されたScheduleVersionはfreezeされ変更できない", () => {
    const version = createScheduleVersion("build", {
      effectiveFrom: "2024-01-01",
      daysOfWeek: [0],
      targetCount: 1,
    });

    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (version as any).targetCount = 5;
    }).toThrow();
  });

  it("daysOfWeekが空の場合は拒否する", () => {
    expect(() =>
      createScheduleVersion("build", {
        effectiveFrom: "2024-01-01",
        daysOfWeek: [],
        targetCount: 1,
      }),
    ).toThrow(InvalidScheduleVersionError);
  });

  it("daysOfWeekが0〜6の範囲外の場合は拒否する", () => {
    expect(() =>
      createScheduleVersion("build", {
        effectiveFrom: "2024-01-01",
        daysOfWeek: [7],
        targetCount: 1,
      }),
    ).toThrow(InvalidScheduleVersionError);

    expect(() =>
      createScheduleVersion("build", {
        effectiveFrom: "2024-01-01",
        daysOfWeek: [-1],
        targetCount: 1,
      }),
    ).toThrow(InvalidScheduleVersionError);
  });

  it("daysOfWeekに重複がある場合は拒否する", () => {
    expect(() =>
      createScheduleVersion("build", {
        effectiveFrom: "2024-01-01",
        daysOfWeek: [1, 1, 2],
        targetCount: 1,
      }),
    ).toThrow(InvalidScheduleVersionError);
  });

  it("targetCountが0以下の場合は拒否する", () => {
    expect(() =>
      createScheduleVersion("build", {
        effectiveFrom: "2024-01-01",
        daysOfWeek: [0],
        targetCount: 0,
      }),
    ).toThrow(InvalidScheduleVersionError);

    expect(() =>
      createScheduleVersion("build", {
        effectiveFrom: "2024-01-01",
        daysOfWeek: [0],
        targetCount: -1,
      }),
    ).toThrow(InvalidScheduleVersionError);
  });

  it("targetCountが整数でない場合は拒否する", () => {
    expect(() =>
      createScheduleVersion("build", {
        effectiveFrom: "2024-01-01",
        daysOfWeek: [0],
        targetCount: 1.5,
      }),
    ).toThrow(InvalidScheduleVersionError);
  });

  it("reduceでtargetCount=1は受理する", () => {
    const version = createScheduleVersion("reduce", {
      effectiveFrom: "2024-01-01",
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      targetCount: 1,
    });

    expect(version.targetCount).toBe(1);
  });

  it("reduceでtargetCountが1以外の場合は拒否する", () => {
    expect(() =>
      createScheduleVersion("reduce", {
        effectiveFrom: "2024-01-01",
        daysOfWeek: [0],
        targetCount: 2,
      }),
    ).toThrow(InvalidScheduleVersionError);
  });

  it("effectiveFromが不正な暦日の場合は拒否する", () => {
    expect(() =>
      createScheduleVersion("build", {
        effectiveFrom: "2024-02-30",
        daysOfWeek: [0],
        targetCount: 1,
      }),
    ).toThrow(InvalidScheduleVersionError);
  });

  it("effectiveToがeffectiveFromより前の場合は拒否する", () => {
    expect(() =>
      createScheduleVersion("build", {
        effectiveFrom: "2024-02-01",
        effectiveTo: "2024-01-01",
        daysOfWeek: [0],
        targetCount: 1,
      }),
    ).toThrow(InvalidScheduleVersionError);
  });

  it("effectiveFromとeffectiveToが同日の場合は受理する", () => {
    const version = createScheduleVersion("build", {
      effectiveFrom: "2024-01-01",
      effectiveTo: "2024-01-01",
      daysOfWeek: [0],
      targetCount: 1,
    });

    expect(version.effectiveTo).toBe("2024-01-01");
  });
});

describe("closeScheduleVersion", () => {
  it("effectiveToを差し替えた新しいScheduleVersionを返し、元のオブジェクトは変更しない", () => {
    const original = createScheduleVersion("build", {
      effectiveFrom: "2024-01-01",
      daysOfWeek: [0],
      targetCount: 1,
    });

    const closed = closeScheduleVersion(original, "2024-03-31");

    expect(closed.effectiveFrom).toBe("2024-01-01");
    expect(closed.effectiveTo).toBe("2024-03-31");
    expect(original.effectiveTo).toBeNull();
  });

  it("effectiveFromより前のeffectiveToは拒否する", () => {
    const original = createScheduleVersion("build", {
      effectiveFrom: "2024-01-01",
      daysOfWeek: [0],
      targetCount: 1,
    });

    expect(() => closeScheduleVersion(original, "2023-12-31")).toThrow(InvalidScheduleVersionError);
  });
});

describe("scheduleVersionsOverlap / assertNoOverlappingScheduleVersions", () => {
  it("有効期間が重ならない連続した2版は受理する", () => {
    const a = createScheduleVersion("build", {
      effectiveFrom: "2024-01-01",
      effectiveTo: "2024-03-31",
      daysOfWeek: [0],
      targetCount: 1,
    });
    const b = createScheduleVersion("build", {
      effectiveFrom: "2024-04-01",
      daysOfWeek: [0],
      targetCount: 2,
    });

    expect(scheduleVersionsOverlap(a, b)).toBe(false);
    expect(() => assertNoOverlappingScheduleVersions([a, b])).not.toThrow();
  });

  it("有効期間が重なる2版は拒否する", () => {
    const a = createScheduleVersion("build", {
      effectiveFrom: "2024-01-01",
      effectiveTo: "2024-04-01",
      daysOfWeek: [0],
      targetCount: 1,
    });
    const b = createScheduleVersion("build", {
      effectiveFrom: "2024-03-01",
      daysOfWeek: [0],
      targetCount: 2,
    });

    expect(scheduleVersionsOverlap(a, b)).toBe(true);
    expect(() => assertNoOverlappingScheduleVersions([a, b])).toThrow(
      OverlappingScheduleVersionError,
    );
  });

  it("片方が無期限(effectiveTo=null)で、もう片方の開始日を含む場合は重複とみなす", () => {
    const openEnded = createScheduleVersion("build", {
      effectiveFrom: "2024-01-01",
      daysOfWeek: [0],
      targetCount: 1,
    });
    const later = createScheduleVersion("build", {
      effectiveFrom: "2024-06-01",
      daysOfWeek: [0],
      targetCount: 2,
    });

    expect(scheduleVersionsOverlap(openEnded, later)).toBe(true);
  });
});

describe("isTargetMet", () => {
  it("buildはquantityがtargetCount以上で成功", () => {
    expect(isTargetMet({ targetCount: 3 }, 3)).toBe(true);
    expect(isTargetMet({ targetCount: 3 }, 4)).toBe(true);
    expect(isTargetMet({ targetCount: 3 }, 2)).toBe(false);
  });

  it("reduce(targetCount=1)はquantityが1以上で成功", () => {
    expect(isTargetMet({ targetCount: 1 }, 1)).toBe(true);
    expect(isTargetMet({ targetCount: 1 }, 0)).toBe(false);
  });
});
