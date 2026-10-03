import { describe, expect, it } from "vitest";

import { decodeHabitCursor, encodeHabitCursor } from "./cursor";
import { InvalidCursorError } from "./errors";

const HABIT_ID = "5d1b6d4e-6b1c-4a0e-9e0e-7a0f8d5b8c11";

describe("habit cursor(HAPI-002)", () => {
  it("往復できる", () => {
    const cursor = encodeHabitCursor({ habitId: HABIT_ID, status: "active" });
    expect(decodeHabitCursor(cursor, "active")).toEqual({ habitId: HABIT_ID });
  });

  it("URLに安全な文字のみで構成され、内部ID/ユーザーIDを示すキーを含まない", () => {
    const cursor = encodeHabitCursor({ habitId: HABIT_ID, status: "archived" });
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    const payload = Buffer.from(cursor, "base64url").toString("utf8");
    expect(Object.keys(JSON.parse(payload) as object).sort()).toEqual(["h", "s", "v"]);
  });

  it("発行時と異なるstatusで使うと拒否する", () => {
    const cursor = encodeHabitCursor({ habitId: HABIT_ID, status: "active" });
    expect(() => decodeHabitCursor(cursor, "archived")).toThrow(InvalidCursorError);
  });

  it.each([
    ["非base64/非JSON", "!!!not-a-cursor!!!"],
    ["JSONだがオブジェクトではない", Buffer.from("123").toString("base64url")],
    ["null", Buffer.from("null").toString("base64url")],
    [
      "versionが異なる",
      Buffer.from(JSON.stringify({ v: 2, h: HABIT_ID, s: "active" })).toString("base64url"),
    ],
    [
      "habitIdがUUIDでない",
      Buffer.from(JSON.stringify({ v: 1, h: "12", s: "active" })).toString("base64url"),
    ],
    ["キー欠落", Buffer.from(JSON.stringify({ v: 1 })).toString("base64url")],
  ])("不正なcursorを拒否する: %s", (_label, cursor) => {
    expect(() => decodeHabitCursor(cursor, "active")).toThrow(InvalidCursorError);
  });
});
