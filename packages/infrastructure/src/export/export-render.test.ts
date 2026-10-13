import { crc32 as nodeCrc32 } from "node:zlib";

import fc from "fast-check";
import {
  EXPORT_CSV_FILE_NAMES,
  EXPORT_SCHEMA_VERSION,
  buildExportCsvZip,
  buildExportJson,
  buildStoredZip,
  crc32,
  encodeUtf8,
} from "@habit-app/domain";
import type { ExportBundle } from "@habit-app/domain";
import { describe, expect, it } from "vitest";

/**
 * Domain の出力(JSON / CSV の ZIP / UTF-8 / CRC-32)を、Node の標準実装と独立したパーサで検証する。
 * Domain は Node の型に依存しないため、Node との突き合わせはここ(型のある側)で行う。
 */

const decoder = new TextDecoder();
const EXPORTED_AT = new Date("2026-10-13T03:00:12.000Z");

interface ParsedZip {
  readonly name: string;
  readonly data: Uint8Array;
  readonly crc: number;
}

/** 実装とは独立に書いた最小の ZIP パーサ(中央ディレクトリ → ローカルヘッダ)。保存のみ対応。 */
function parseZip(bytes: Uint8Array): ParsedZip[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = bytes.length - 22;
  expect(view.getUint32(eocd, true)).toBe(0x06054b50);
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const result: ParsedZip[] = [];
  for (let i = 0; i < count; i += 1) {
    expect(view.getUint32(offset, true)).toBe(0x02014b50);
    const method = view.getUint16(offset + 10, true);
    const crc = view.getUint32(offset + 16, true);
    const compressed = view.getUint32(offset + 20, true);
    const size = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    expect(method).toBe(0);
    expect(compressed).toBe(size);
    // 汎用フラグの bit 11(UTF-8 のファイル名)が、中央ディレクトリとローカルヘッダの両方に立っている。
    expect(view.getUint16(offset + 8, true) & 0x0800).toBe(0x0800);
    expect(view.getUint16(localOffset + 6, true) & 0x0800).toBe(0x0800);

    expect(view.getUint32(localOffset, true)).toBe(0x04034b50);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    result.push({ name, data: bytes.slice(dataStart, dataStart + size), crc });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return result;
}

function bundle(overrides: Partial<ExportBundle> = {}): ExportBundle {
  const habitId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  return {
    account: { email: "taro@example.test", createdAt: "2026-09-01T00:00:00.000Z" },
    profile: { displayName: "たろう", timezone: "Asia/Tokyo", locale: "ja", weekStartsOn: 1 },
    habits: [
      {
        id: habitId,
        kind: "build",
        name: "散歩",
        purpose: "健康のため",
        cue: "朝食のあと",
        minimumAction: "玄関を出る",
        replacementAction: null,
        status: "active",
        createdAt: "2026-09-02T00:00:00.000Z",
        updatedAt: "2026-09-02T00:00:00.000Z",
        scheduleVersions: [
          {
            habitId,
            effectiveFrom: "2026-09-02",
            effectiveTo: null,
            daysOfWeek: [1, 2, 3],
            targetCount: 1,
          },
        ],
      },
    ],
    habitEntries: [
      {
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        habitId,
        date: "2026-09-03",
        status: "success",
        quantity: 1,
        note: "=SUM(1,1)",
        source: "web",
        createdAt: "2026-09-03T01:00:00.000Z",
        updatedAt: "2026-09-03T01:00:00.000Z",
      },
    ],
    dailyCheckIns: [
      {
        date: "2026-09-03",
        mood: 4,
        difficulty: null,
        note: 'カンマ,と"引用"\nと改行',
        createdAt: "2026-09-03T12:00:00.000Z",
        updatedAt: "2026-09-03T12:00:00.000Z",
      },
    ],
    weeklyReviews: [
      {
        id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        weekStart: "2026-08-31",
        timezoneSnapshot: "Asia/Tokyo",
        summary: { scheduled: 5, success: 4 },
        reflection: "-5 から始まる",
        status: "completed",
        completedAt: "2026-09-07T00:00:00.000Z",
        createdAt: "2026-09-07T00:00:00.000Z",
      },
    ],
    notificationSettings: {
      enabled: true,
      localTime: "20:00",
      timezone: "Asia/Tokyo",
      quietHours: { start: "22:00", end: "07:00" },
    },
    aiResults: [
      {
        id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        kind: "weekly_improvement",
        status: "succeeded",
        promptVersion: "v1",
        outputSchemaVersion: "v1",
        provider: "fake",
        model: "fake-1",
        result: { observations: ["良い"] },
        failureCode: null,
        createdAt: "2026-09-08T00:00:00.000Z",
      },
    ],
    ...overrides,
  };
}

describe("encodeUtf8 は Node の TextEncoder と一致する", () => {
  it("性質: 任意の文字列(絵文字・対になっていないサロゲートを含む)で同じバイト列", () => {
    const encoder = new TextEncoder();
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 40 }), (text) => {
        expect([...encodeUtf8(text)]).toEqual([...encoder.encode(text)]);
      }),
      { numRuns: 500 },
    );
  });
});

describe("crc32 / buildStoredZip は標準と一致し、往復できる", () => {
  it("性質: crc32 は Node の zlib.crc32 と一致する", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 200 }), (bytes) => {
        expect(crc32(bytes)).toBe(nodeCrc32(bytes));
      }),
      { numRuns: 300 },
    );
  });

  it("性質: 任意のファイル群を ZIP にして、独立したパーサで読むと名前・内容・CRC が一致する", () => {
    const name = fc.stringMatching(/^[A-Za-z0-9._-]{1,20}$/);
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.record({ name, data: fc.uint8Array({ maxLength: 300 }) }), {
          selector: (entry) => entry.name,
          maxLength: 8,
        }),
        (entries) => {
          const parsed = parseZip(buildStoredZip(entries, EXPORTED_AT));
          expect(parsed.map((p) => p.name)).toEqual(entries.map((e) => e.name));
          parsed.forEach((p, i) => {
            expect([...p.data]).toEqual([...(entries[i]?.data ?? [])]);
            expect(p.crc).toBe(nodeCrc32(entries[i]?.data ?? new Uint8Array()));
          });
        },
      ),
      { numRuns: 100 },
    );
  });

  it("システムの unzip で検証できる(CRC・構造が正しい)", async () => {
    const { execFileSync } = await import("node:child_process");
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zip-check-"));
    try {
      const file = path.join(dir, "export.zip");
      fs.writeFileSync(file, buildExportCsvZip(bundle(), EXPORTED_AT));
      let output: string;
      try {
        output = execFileSync("unzip", ["-t", file], { encoding: "utf8" });
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === "ENOENT") return; // unzip が無い環境では、独立パーサでの検証に任せる。
        throw error;
      }
      expect(output).toContain("No errors detected");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("buildExportJson", () => {
  const json = (b: ExportBundle) =>
    JSON.parse(decoder.decode(buildExportJson(b, EXPORTED_AT))) as Record<string, unknown>;

  it("トップレベルの構造と schemaVersion、許可リストの項目のみ", () => {
    const doc = json(bundle());
    expect(Object.keys(doc)).toEqual([
      "schemaVersion",
      "exportedAt",
      "account",
      "profile",
      "habits",
      "habitEntries",
      "dailyCheckIns",
      "weeklyReviews",
      "notificationSettings",
      "aiResults",
    ]);
    expect(doc["schemaVersion"]).toBe(EXPORT_SCHEMA_VERSION);
    expect(doc["exportedAt"]).toBe("2026-10-13T03:00:12.000Z");
    expect(doc["account"]).toEqual({
      email: "taro@example.test",
      createdAt: "2026-09-01T00:00:00.000Z",
    });
    const habits = doc["habits"] as Record<string, unknown>[];
    expect(Object.keys(habits[0] ?? {})).toEqual([
      "id",
      "kind",
      "name",
      "purpose",
      "cue",
      "minimumAction",
      "replacementAction",
      "status",
      "createdAt",
      "updatedAt",
      "scheduleVersions",
    ]);
  });

  it("日本語・改行・引用符はそのまま(JSON のエスケープのみ)で、往復できる", () => {
    const doc = json(bundle());
    const checkIns = doc["dailyCheckIns"] as { note: string }[];
    expect(checkIns[0]?.note).toBe('カンマ,と"引用"\nと改行');
    const habits = doc["habits"] as { name: string }[];
    expect(habits[0]?.name).toBe("散歩");
  });

  it("データが空でも有効な JSON(空の配列・null)", () => {
    const doc = json(
      bundle({
        profile: null,
        habits: [],
        habitEntries: [],
        dailyCheckIns: [],
        weeklyReviews: [],
        notificationSettings: null,
        aiResults: [],
      }),
    );
    expect(doc["profile"]).toBeNull();
    expect(doc["habits"]).toEqual([]);
    expect(doc["notificationSettings"]).toBeNull();
  });
});

describe("buildExportCsvZip", () => {
  const files = (b: ExportBundle) => {
    const map = new Map<string, Uint8Array>();
    for (const entry of parseZip(buildExportCsvZip(b, EXPORTED_AT)))
      map.set(entry.name, entry.data);
    return map;
  };

  it("決められたファイル名の一式が入っている(ディレクトリを含まない)", () => {
    expect([...files(bundle()).keys()]).toEqual([...EXPORT_CSV_FILE_NAMES]);
  });

  it("CSV は BOM 付きの UTF-8 で CRLF。ヘッダーは JSON と同じ項目名", () => {
    const map = files(bundle());
    const habits = map.get("habits.csv") ?? new Uint8Array();
    expect([...habits.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = decoder.decode(habits.slice(3));
    expect(text.split("\r\n")[0]).toBe(
      "id,kind,name,purpose,cue,minimumAction,replacementAction,status,createdAt,updatedAt",
    );
    expect(text.endsWith("\r\n")).toBe(true);
  });

  it("数式になりうる値は無害化され、カンマ・引用符・改行は引用される", () => {
    const map = files(bundle());
    const entries = decoder.decode((map.get("habit_entries.csv") ?? new Uint8Array()).slice(3));
    expect(entries).toContain(`"'=SUM(1,1)"`);
    const checkIns = decoder.decode((map.get("daily_check_ins.csv") ?? new Uint8Array()).slice(3));
    expect(checkIns).toContain('"カンマ,と""引用""\nと改行"');
    const reviews = decoder.decode((map.get("weekly_reviews.csv") ?? new Uint8Array()).slice(3));
    expect(reviews).toContain("'-5 から始まる");
  });

  it("入れ子の値は JSON 文字列、quiet hours は開始と終了の列に分かれる", () => {
    const map = files(bundle());
    const schedules = decoder.decode(
      (map.get("habit_schedule_versions.csv") ?? new Uint8Array()).slice(3),
    );
    expect(schedules).toContain('"[1,2,3]"');
    const settings = decoder.decode(
      (map.get("notification_settings.csv") ?? new Uint8Array()).slice(3),
    );
    expect(settings.split("\r\n")[0]).toBe(
      "enabled,localTime,timezone,quietHoursStart,quietHoursEnd",
    );
    expect(settings).toContain("true,20:00,Asia/Tokyo,22:00,07:00");
  });

  it("データが空でもヘッダーのみの CSV と README が入る", () => {
    const map = files(
      bundle({
        profile: null,
        habits: [],
        habitEntries: [],
        dailyCheckIns: [],
        weeklyReviews: [],
        notificationSettings: null,
        aiResults: [],
      }),
    );
    expect(decoder.decode((map.get("habits.csv") ?? new Uint8Array()).slice(3))).toBe(
      "id,kind,name,purpose,cue,minimumAction,replacementAction,status,createdAt,updatedAt\r\n",
    );
    expect(decoder.decode(map.get("README.txt") ?? new Uint8Array())).toContain("schemaVersion: 1");
  });

  it("性質: 任意のメモを入れても、CSV のどのセルも数式として解釈されうる先頭文字で始まらない", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 30 }), (note) => {
        const b = bundle({
          dailyCheckIns: [
            {
              date: "2026-09-03",
              mood: 1,
              difficulty: 1,
              note,
              createdAt: "2026-09-03T12:00:00.000Z",
              updatedAt: "2026-09-03T12:00:00.000Z",
            },
          ],
        });
        const raw = files(b).get("daily_check_ins.csv") ?? new Uint8Array();
        const text = decoder.decode(raw.slice(3));
        // 行頭ではなくセル単位で検査する: 3 列目(note)を取り出す。
        const body = text.slice(text.indexOf("\r\n") + 2);
        const afterTwoCommas = body.split(",").slice(3).join(",");
        expect(["=", "+", "-", "@", "\t", "\r"]).not.toContain(afterTwoCommas.charAt(0));
      }),
      { numRuns: 200 },
    );
  });
});
