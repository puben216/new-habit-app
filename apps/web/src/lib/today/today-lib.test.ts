import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, CLIENT_ERROR_CODES } from "@/lib/api/api-error";

import { toCheckInBody, validateCheckIn } from "./check-in";
import { addDays, buildDateOptions, parseSelectedDate } from "./dates";
import { actionForEntry, entryBodyFor, entryLabel, type Entry } from "./entry-actions";
import { getCheckIn } from "./today-api";
import { UNEXPECTED_MESSAGE, describeCheckInError, describeRecordError } from "./messages";

const entry = (status: Entry["status"], quantity: number | null): Entry => ({
  status,
  quantity,
  updatedAt: "2026-10-09T00:00:00.000Z",
});

describe("addDays / buildDateOptions", () => {
  it("月・年をまたいで加減算する", () => {
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2024-03-01", -1)).toBe("2024-02-29");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
  });

  it("今日から earliest まで新しい順。ラベルは今日/昨日/月日(曜)", () => {
    const options = buildDateOptions("2026-10-09", "2026-10-02");
    expect(options).toHaveLength(8);
    expect(options[0]).toEqual({ date: "2026-10-09", label: "今日" });
    expect(options[1]).toEqual({ date: "2026-10-08", label: "昨日" });
    expect(options[2]).toEqual({ date: "2026-10-07", label: "10/7(水)" });
    expect(options[7]?.date).toBe("2026-10-02");
  });

  it("earliest が今日より後(不整合)でも今日だけは返す", () => {
    expect(buildDateOptions("2026-10-09", "2026-10-10")).toEqual([
      { date: "2026-10-09", label: "今日" },
    ]);
  });

  it("性質: 連続した日付で、先頭が今日、末尾が earliest", () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date("2001-01-01"), max: new Date("2099-12-31"), noInvalidDate: true }),
        fc.integer({ min: 0, max: 30 }),
        (instant, span) => {
          const today = instant.toISOString().slice(0, 10);
          const earliest = addDays(today, -span);
          const options = buildDateOptions(today, earliest);
          expect(options).toHaveLength(span + 1);
          expect(options[0]?.date).toBe(today);
          expect(options[options.length - 1]?.date).toBe(earliest);
          options.slice(1).forEach((option, index) => {
            expect(option.date).toBe(addDays(options[index]?.date ?? "", -1));
          });
        },
      ),
    );
  });
});

describe("parseSelectedDate", () => {
  const options = buildDateOptions("2026-10-09", "2026-10-02");
  it("選択肢にある日付だけを採用し、それ以外は今日", () => {
    expect(parseSelectedDate("2026-10-05", options, "2026-10-09")).toBe("2026-10-05");
    expect(parseSelectedDate("2026-10-01", options, "2026-10-09")).toBe("2026-10-09");
    expect(parseSelectedDate("2026-10-10", options, "2026-10-09")).toBe("2026-10-09");
    expect(parseSelectedDate("abc", options, "2026-10-09")).toBe("2026-10-09");
    expect(parseSelectedDate(undefined, options, "2026-10-09")).toBe("2026-10-09");
    expect(parseSelectedDate(["2026-10-05", "x"], options, "2026-10-09")).toBe("2026-10-05");
  });
});

describe("entryBodyFor", () => {
  it("操作から status を決める。reduce の途中経過・skipped は quantity を持たない", () => {
    expect(entryBodyFor("build", "done")).toEqual({ status: "success" });
    expect(entryBodyFor("build", "missed")).toEqual({ status: "missed" });
    expect(entryBodyFor("build", "skipped")).toEqual({ status: "skipped" });
    expect(entryBodyFor("build", "progress", 2)).toEqual({ status: "missed", quantity: 2 });
    expect(entryBodyFor("reduce", "progress", 2)).toEqual({ status: "missed" });
    expect(entryBodyFor("reduce", "done")).toEqual({ status: "success" });
  });
});

describe("actionForEntry / entryLabel", () => {
  it("記録を操作に対応づける", () => {
    expect(actionForEntry(null)).toBeNull();
    expect(actionForEntry(entry("success", 1))).toBe("done");
    expect(actionForEntry(entry("skipped", null))).toBe("skipped");
    expect(actionForEntry(entry("missed", null))).toBe("missed");
    expect(actionForEntry(entry("missed", 0))).toBe("missed");
    expect(actionForEntry(entry("missed", 1))).toBe("progress");
  });

  it("状態を文字で表す(色に依存しない)", () => {
    expect(entryLabel("build", null, 1)).toBe("未記録");
    expect(entryLabel("build", entry("success", 1), 1)).toBe("できた");
    expect(entryLabel("build", entry("success", 3), 3)).toBe("できた(3/3回)");
    expect(entryLabel("build", entry("missed", 1), 3)).toBe("途中経過(1/3回)");
    expect(entryLabel("build", entry("missed", null), 3)).toBe("できなかった");
    expect(entryLabel("reduce", entry("success", null), 1)).toBe("回避できた");
    expect(entryLabel("reduce", entry("missed", null), 1)).toBe("してしまった");
    expect(entryLabel("reduce", entry("skipped", null), 1)).toBe("スキップ");
  });
});

describe("check-in", () => {
  it("3 項目すべて未設定(メモが空白のみを含む)は empty", () => {
    expect(validateCheckIn({ mood: null, difficulty: null, note: "  \n" })).toBe("empty");
    expect(validateCheckIn({ mood: 3, difficulty: null, note: "" })).toBeNull();
    expect(validateCheckIn({ mood: null, difficulty: null, note: "ok" })).toBeNull();
  });

  it("メモの上限は 1000 文字", () => {
    expect(validateCheckIn({ mood: 1, difficulty: null, note: "a".repeat(1000) })).toBeNull();
    expect(validateCheckIn({ mood: 1, difficulty: null, note: "a".repeat(1001) })).toBe(
      "note_too_long",
    );
  });

  it("body は全項目を置換し、未設定は null、空白のみのメモは null", () => {
    expect(toCheckInBody({ mood: 4, difficulty: null, note: "  " })).toEqual({
      mood: 4,
      difficulty: null,
      note: null,
    });
    expect(toCheckInBody({ mood: null, difficulty: 2, note: "メモ\n2行目" })).toEqual({
      mood: null,
      difficulty: 2,
      note: "メモ\n2行目",
    });
  });
});

describe("messages", () => {
  it("記録エラーは code から固定文言。server の文字列は使わない", () => {
    const error = new ApiError({
      status: 422,
      code: "invalid_habit_entry",
      fieldErrors: { quantity: ["SECRET"] },
    });
    expect(describeRecordError(error)).toContain("目標回数より少ない");
    expect(describeRecordError(error)).not.toContain("SECRET");
    expect(
      describeRecordError(new ApiError({ status: 422, code: "habit_not_scheduled" })),
    ).toContain("予定のない");
    expect(describeRecordError(new ApiError({ status: 409, code: "habit_archived" }))).toContain(
      "アーカイブ済み",
    );
    expect(
      describeRecordError(new ApiError({ status: 0, code: CLIENT_ERROR_CODES.networkError })),
    ).toContain("通信");
    expect(describeRecordError(new ApiError({ status: 500, code: "x" }))).toBe(UNEXPECTED_MESSAGE);
    expect(describeRecordError(new Error("SECRET"))).toBe(UNEXPECTED_MESSAGE);
  });

  it("チェックインのエラーも固定文言", () => {
    expect(describeCheckInError(new ApiError({ status: 422, code: "invalid_check_in" }))).toContain(
      "1つ以上",
    );
    expect(
      describeCheckInError(new ApiError({ status: 422, code: "check_in_date_out_of_range" })),
    ).toContain("範囲");
    expect(describeCheckInError(new ApiError({ status: 500, code: "x" }))).toBe(UNEXPECTED_MESSAGE);
  });
});

describe("getCheckIn", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubFetch(status: number, body: unknown) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(body), { status })),
    );
  }

  it("check_in_not_found の 404 は未記録(null)", async () => {
    stubFetch(404, { code: "check_in_not_found", message: "x", requestId: "r" });
    await expect(getCheckIn("2026-10-09")).resolves.toBeNull();
  });

  it("別の 404(user_not_found 等)や 5xx は null にせず投げる", async () => {
    stubFetch(404, { code: "user_not_found", message: "x", requestId: "r" });
    await expect(getCheckIn("2026-10-09")).rejects.toBeInstanceOf(ApiError);
    stubFetch(500, { code: "internal_error", message: "x", requestId: "r" });
    await expect(getCheckIn("2026-10-09")).rejects.toBeInstanceOf(ApiError);
  });

  it("200 は schema 検証して返す", async () => {
    stubFetch(200, {
      date: "2026-10-09",
      mood: 4,
      difficulty: null,
      note: null,
      updatedAt: "2026-10-09T00:00:00.000Z",
    });
    await expect(getCheckIn("2026-10-09")).resolves.toMatchObject({ mood: 4 });
  });
});
