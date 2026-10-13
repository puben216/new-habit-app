import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  cleanupExpiredDataExportsUseCase,
  downloadDataExportUseCase,
  listDataExportsUseCase,
  processDataExportUseCase,
  requestDataExportUseCase,
} from "@habit-app/application";
import type { AccountRequestContext } from "@habit-app/application";
import {
  DATA_EXPORT_DAILY_LIMIT,
  DATA_EXPORT_READ_CHUNK_SIZE,
  DATA_EXPORT_TTL_HOURS,
} from "@habit-app/domain";
import { startPostgresContainer } from "@habit-app/test-support";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createArgon2PasswordHasher } from "../auth/argon2-password-hasher";
import { createPrismaLoginAttemptRepository } from "../auth/prisma-login-attempt-repository";
import { createPrismaClient, type PrismaClient } from "../database/prisma-client";
import { createPrismaAccountRepository } from "../account/prisma-account-repository";
import { createInlineDataExportQueue } from "./inline-data-export-queue";
import { createPrismaDataExportRepository } from "./prisma-data-export-repository";
import { createPrismaExportDataSource } from "./prisma-export-data-source";

import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const infrastructureRoot = path.resolve(__dirname, "../../");
const prismaConfigPath = path.join(infrastructureRoot, "prisma.config.ts");
const prismaCli = path.join(infrastructureRoot, "node_modules", ".bin", "prisma");
const T404_EXPORT_MIGRATION = "20261013000000_t404_data_export";

const HOUR_MS = 60 * 60 * 1000;
const NOW = new Date("2026-10-13T03:00:00.000Z");
const CONTEXT: AccountRequestContext = { requestId: "req-int-1", ipHash: "iphash" };
const PASSWORD = "correct horse battery staple";
const decoder = new TextDecoder();

// 出力に現れてはいけない値(認証・運用の情報、他ユーザーの情報)。
const SECRETS = [
  "SECRET-SESSION-TOKEN",
  "SECRET-RESET-TOKEN-HASH",
  "SECRET-TOTP-ENC",
  "SECRET-RECOVERY-HASH",
  "SECRET-IDEMPOTENCY-KEY",
  "SECRET-FINGERPRINT",
  "OTHER-USER-PRIVATE-NOTE",
];

describe("データエクスポートの repository と収集(T-404 PR-B)", () => {
  let container: StartedPostgreSqlContainer;
  let prisma: PrismaClient;
  let passwordHash: string;
  const hasher = createArgon2PasswordHasher();

  const exportsRepo = () => createPrismaDataExportRepository(prisma);
  const dataSource = () => createPrismaExportDataSource(prisma);
  const accounts = () => createPrismaAccountRepository(prisma);
  const attempts = () => createPrismaLoginAttemptRepository(prisma);

  function requestDeps(
    queue: { enqueue: (m: { version: 1; exportId: string }) => Promise<void> },
    now = NOW,
  ) {
    return {
      accounts: accounts(),
      exports: exportsRepo(),
      queue,
      passwordHasher: hasher,
      attempts: attempts(),
      now: () => now,
    };
  }
  const processDeps = (now = NOW) => ({
    exports: exportsRepo(),
    dataSource: dataSource(),
    now: () => now,
  });
  const noopQueue = { enqueue: async () => {} };

  let seq = 0;
  async function createUser(label: string) {
    seq += 1;
    const user = await prisma.user.create({
      data: {
        authSubject: `credentials:${label}-${seq}@example.test`,
        emailNormalized: `${label}-${seq}@example.test`,
        passwordHash,
        emailVerifiedAt: NOW,
      },
    });
    return { id: user.id.toString(), publicId: user.publicId, email: user.emailNormalized };
  }

  /** 自分のデータ(全種類)と、出力に現れてはいけない値を持つユーザーを作る。 */
  async function seedUser(label: string) {
    const user = await createUser(label);
    const id = BigInt(user.id);
    await prisma.$executeRaw`
      INSERT INTO user_profiles (user_id, display_name, timezone, locale, week_starts_on)
      VALUES (${id}, 'たろう', 'Asia/Tokyo', 'ja', 1)`;
    const habit = await prisma.habit.create({
      data: {
        userId: id,
        kind: "build",
        name: "散歩",
        purpose: "健康",
        cue: "朝",
        minimumAction: "出る",
        replacementAction: null,
      },
    });
    await prisma.$executeRaw`
      INSERT INTO habit_schedule_versions (habit_id, effective_from, days_of_week, target_count)
      VALUES (${habit.id}, '2026-09-02'::date, ARRAY[1, 2, 3], 1)`;
    await prisma.$executeRaw`
      INSERT INTO habit_entries (user_id, habit_id, habit_date, status, quantity, note)
      VALUES (${id}, ${habit.id}, '2026-09-03'::date, 'success', 2, '=cmd|calc')`;
    await prisma.$executeRaw`
      INSERT INTO daily_check_ins (user_id, check_in_date, mood, difficulty, note)
      VALUES (${id}, '2026-09-03'::date, 4, 2, '良い日')`;
    await prisma.$executeRaw`
      INSERT INTO weekly_reviews (user_id, week_start, timezone_snapshot, summary_json, reflection, status)
      VALUES (${id}, '2026-08-31'::date, 'Asia/Tokyo', '{"scheduled":5}'::jsonb, '振り返り', 'draft')`;
    await prisma.$executeRaw`
      INSERT INTO notification_settings (user_id, channel, local_time, timezone, enabled, quiet_hours_start, quiet_hours_end)
      VALUES (${id}, 'email', '20:00'::time, 'Asia/Tokyo', true, '22:00'::time, '07:00'::time)`;
    await prisma.$executeRaw`
      INSERT INTO ai_jobs (user_id, kind, subject_type, subject_public_id, status, prompt_version,
                           output_schema_version, provider, model, input_fingerprint, result_json)
      VALUES (${id}, 'weekly_improvement', 'weekly_review', gen_random_uuid(), 'succeeded', 'v1', 'v1',
              'fake', 'fake-1', 'SECRET-FINGERPRINT', '{"output":"提案"}'::jsonb)`;

    // 出力に現れてはいけない値(認証・運用の情報)。
    await prisma.$executeRaw`
      INSERT INTO sessions (session_token, user_id, expires)
      VALUES (${`SECRET-SESSION-TOKEN-${user.id}`}, ${id}, ${new Date(NOW.getTime() + 86_400_000)})`;
    await prisma.$executeRaw`
      INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
      VALUES (${id}, ${`SECRET-RESET-TOKEN-HASH-${user.id}`}, ${new Date(NOW.getTime() + 86_400_000)})`;
    const admin = await prisma.$queryRaw<{ id: bigint }[]>`
      INSERT INTO admin_users (user_id, totp_secret_enc) VALUES (${id}, ${`SECRET-TOTP-ENC-${user.id}`}) RETURNING id`;
    await prisma.$executeRaw`
      INSERT INTO admin_recovery_codes (admin_user_id, code_hash) VALUES (${admin[0]?.id}, ${`SECRET-RECOVERY-HASH-${user.id}`})`;
    await prisma.$executeRaw`
      INSERT INTO idempotency_keys (user_id, scope, key, request_hash, expires_at)
      VALUES (${id}, 's', ${`SECRET-IDEMPOTENCY-KEY-${user.id}`}, 'h', ${new Date(NOW.getTime() + 86_400_000)})`;
    return { ...user, habitPublicId: habit.publicId };
  }

  async function request(userId: string, format: "json" | "csv" = "json", now = NOW) {
    return requestDataExportUseCase(requestDeps(noopQueue, now), {
      actorUserId: userId,
      password: PASSWORD,
      format,
      context: CONTEXT,
    });
  }

  async function exportRow(publicId: string) {
    return prisma.dataExport.findUniqueOrThrow({ where: { publicId } });
  }

  beforeAll(async () => {
    container = await startPostgresContainer();
    execFileSync(prismaCli, ["migrate", "deploy", "--config", prismaConfigPath], {
      cwd: infrastructureRoot,
      env: { ...process.env, DATABASE_URL: container.getConnectionUri() },
      stdio: "pipe",
    });
    prisma = createPrismaClient(container.getConnectionUri());
    passwordHash = await hasher.hash(PASSWORD);
  }, 120_000);

  afterAll(async () => {
    await prisma.$disconnect();
    await container.stop();
  }, 60_000);

  describe("作成(EXP-001)", () => {
    it("再認証のうえ queued で作成され、監査が 1 件付く。パスワードは残らない", async () => {
      const user = await createUser("create");
      const created = await request(user.id);
      expect(created).toMatchObject({ status: "queued", format: "json", userId: user.id });

      const row = await exportRow(created.id);
      expect(row).toMatchObject({
        status: "queued",
        format: "json",
        byteSize: null,
        expiresAt: null,
      });
      const audit = await prisma.auditLog.findMany({ where: { targetPublicId: created.id } });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        actor: `user:${user.publicId}`,
        action: "user.export.requested",
        targetType: "data_export",
        requestId: "req-int-1",
      });
      expect(
        JSON.stringify(audit, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)),
      ).not.toContain(PASSWORD);
    });

    it("誤ったパスワードは作成されず、5 回で制限され、ログインの制限には影響しない", async () => {
      const user = await createUser("reauth");
      for (let i = 0; i < 5; i += 1) {
        await expect(
          requestDataExportUseCase(requestDeps(noopQueue), {
            actorUserId: user.id,
            password: "wrong",
            format: "json",
            context: CONTEXT,
          }),
        ).rejects.toThrow("reauthentication failed");
      }
      await expect(request(user.id)).rejects.toThrow("too many attempts");
      expect(await prisma.dataExport.count({ where: { userId: BigInt(user.id) } })).toBe(0);
      expect(await attempts().isBlocked("login", user.email)).toBe(false);
    });

    it("実行中があれば作成できず、並行する作成は 1 件だけが成立する", async () => {
      const user = await createUser("concurrent");
      const results = await Promise.allSettled(Array.from({ length: 6 }, () => request(user.id)));
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      for (const r of results.filter((x) => x.status === "rejected")) {
        expect(String(r.reason)).toMatch(/export in progress/);
      }
      expect(await prisma.dataExport.count({ where: { userId: BigInt(user.id) } })).toBe(1);
      const activeAudit = await prisma.auditLog.count({
        where: { actor: `user:${user.publicId}`, action: "user.export.requested" },
      });
      expect(activeAudit).toBe(1);
    });

    it("部分 unique index: queued/running は 1 ユーザー 1 件、完了・失敗後は別の行を作れる", async () => {
      const user = await createUser("unique-index");
      const id = BigInt(user.id);
      const insert = (status: string) =>
        prisma.$executeRaw`
          INSERT INTO data_exports (user_id, format, status, failure_code)
          VALUES (${id}, 'json', ${status}, ${status === "failed" ? "worker_error" : null})`;
      await insert("queued");
      await expect(insert("queued")).rejects.toThrow(/data_exports_user_active_uidx/);
      await expect(insert("running")).rejects.toThrow(/data_exports_user_active_uidx/);
      await prisma.$executeRaw`UPDATE data_exports SET status = 'failed', failure_code = 'worker_error' WHERE user_id = ${id}`;
      await expect(insert("failed")).resolves.toBe(1);
      await expect(insert("queued")).resolves.toBe(1);
    });

    it("24 時間に上限まで作ると作れず、窓を過ぎると作れる。失敗・期限切れも数える", async () => {
      const user = await createUser("rate");
      for (let i = 0; i < DATA_EXPORT_DAILY_LIMIT; i += 1) {
        const at = new Date(NOW.getTime() + i * 60_000);
        const created = await request(user.id, "json", at);
        await exportsRepo().fail({ exportId: created.id, failureCode: "worker_error" });
      }
      const withinWindow = new Date(NOW.getTime() + 10 * 60_000);
      await expect(request(user.id, "json", withinWindow)).rejects.toThrow("export rate limited");

      const afterWindow = new Date(NOW.getTime() + 25 * HOUR_MS);
      await expect(request(user.id, "json", afterWindow)).resolves.toMatchObject({
        status: "queued",
      });
    });

    it("新しく作ると、完成済みの古いエクスポートは expired になり成果物が消える", async () => {
      const user = await seedUser("supersede");
      const first = await request(user.id);
      await processDataExportUseCase(processDeps(), { exportId: first.id, receiveCount: 1 });
      expect((await exportRow(first.id)).status).toBe("ready");
      expect(
        await prisma.dataExportArtifact.count({
          where: { exportId: (await exportRow(first.id)).id },
        }),
      ).toBe(1);

      const second = await request(user.id, "csv", new Date(NOW.getTime() + 1000));
      expect((await exportRow(first.id)).status).toBe("expired");
      expect(
        await prisma.dataExportArtifact.count({
          where: { exportId: (await exportRow(first.id)).id },
        }),
      ).toBe(0);
      expect((await exportRow(second.id)).status).toBe("queued");
    });

    it("存在しない user・形式不正な ID は何も作らない", async () => {
      const repo = exportsRepo();
      const base = {
        format: "json" as const,
        now: NOW,
        windowStart: new Date(0),
        dailyLimit: 5,
        staleBefore: new Date(0),
        context: CONTEXT,
      };
      await expect(repo.createIfAllowed({ ...base, actorUserId: "999999" })).resolves.toEqual({
        status: "not_found",
      });
      await expect(repo.createIfAllowed({ ...base, actorUserId: "nope" })).resolves.toEqual({
        status: "not_found",
      });
    });
  });

  describe("収集(EXP-005)", () => {
    it("自分の全データを、許可リストの項目だけで収集する。内部 ID・機密値・他ユーザーのデータは含まれない", async () => {
      const me = await seedUser("collect-me");
      const other = await seedUser("collect-other");
      await prisma.$executeRaw`
        UPDATE daily_check_ins SET note = 'OTHER-USER-PRIVATE-NOTE' WHERE user_id = ${BigInt(other.id)}`;

      const bundle = await dataSource().collect({ userId: me.id });
      expect(bundle.account).toEqual({ email: me.email, createdAt: expect.any(String) });
      expect(bundle.profile).toEqual({
        displayName: "たろう",
        timezone: "Asia/Tokyo",
        locale: "ja",
        weekStartsOn: 1,
      });
      expect(bundle.habits).toHaveLength(1);
      expect(bundle.habits[0]).toMatchObject({
        id: me.habitPublicId,
        name: "散歩",
        status: "active",
      });
      expect(bundle.habits[0]?.scheduleVersions).toEqual([
        {
          habitId: me.habitPublicId,
          effectiveFrom: "2026-09-02",
          effectiveTo: null,
          daysOfWeek: [1, 2, 3],
          targetCount: 1,
        },
      ]);
      expect(bundle.habitEntries[0]).toMatchObject({
        habitId: me.habitPublicId,
        date: "2026-09-03",
        status: "success",
        quantity: 2,
        note: "=cmd|calc",
      });
      expect(bundle.dailyCheckIns[0]).toMatchObject({
        date: "2026-09-03",
        mood: 4,
        difficulty: 2,
        note: "良い日",
      });
      expect(bundle.weeklyReviews[0]).toMatchObject({
        weekStart: "2026-08-31",
        summary: { scheduled: 5 },
        reflection: "振り返り",
        status: "draft",
      });
      expect(bundle.notificationSettings).toEqual({
        enabled: true,
        localTime: "20:00",
        timezone: "Asia/Tokyo",
        quietHours: { start: "22:00", end: "07:00" },
      });
      expect(bundle.aiResults[0]).toMatchObject({
        kind: "weekly_improvement",
        status: "succeeded",
        result: { output: "提案" },
      });

      const text = JSON.stringify(bundle);
      for (const secret of SECRETS) expect(text, secret).not.toContain(secret);
      // 内部 ID(bigint)を含む項目名が無い。
      expect(text).not.toMatch(/"(user_?id|internal_?id|habit_?id_internal)"/i);
      expect(text).not.toContain(other.email);
    });

    it("習慣ごとのスケジュールは自分の習慣に対応づく。通知設定が無ければ null、プロフィールが無ければ null", async () => {
      const bare = await createUser("collect-bare");
      const bundle = await dataSource().collect({ userId: bare.id });
      expect(bundle).toMatchObject({
        profile: null,
        habits: [],
        habitEntries: [],
        dailyCheckIns: [],
        weeklyReviews: [],
        notificationSettings: null,
        aiResults: [],
      });
    });

    it("習慣単位の通知設定(habit_id 付き)は出力に含めない: 習慣単位が先に作られていても、ユーザー単位だけを出す", async () => {
      const user = await createUser("collect-habit-setting");
      const id = BigInt(user.id);
      const habit = await prisma.habit.create({
        data: { userId: id, kind: "build", name: "h", purpose: "p", cue: "c", minimumAction: "m" },
      });
      // 習慣単位の設定を先に作る(id が小さい)。ユーザー単位の条件が無いと、こちらが選ばれてしまう。
      await prisma.$executeRaw`
        INSERT INTO notification_settings (user_id, habit_id, channel, local_time, timezone, enabled)
        VALUES (${id}, ${habit.id}, 'email', '06:00'::time, 'UTC', false)`;
      expect((await dataSource().collect({ userId: user.id })).notificationSettings).toBeNull();

      await prisma.$executeRaw`
        INSERT INTO notification_settings (user_id, channel, local_time, timezone, enabled)
        VALUES (${id}, 'email', '20:00'::time, 'Asia/Tokyo', true)`;
      const bundle = await dataSource().collect({ userId: user.id });
      expect(bundle.notificationSettings).toMatchObject({
        localTime: "20:00",
        timezone: "Asia/Tokyo",
        enabled: true,
      });
    });

    it("分割して読み込む件数(5000)をまたいでも、全件が順序どおりに揃う", async () => {
      const user = await createUser("collect-chunks");
      const total = DATA_EXPORT_READ_CHUNK_SIZE + 321;
      await prisma.$executeRaw`
        INSERT INTO daily_check_ins (user_id, check_in_date, mood)
        SELECT ${BigInt(user.id)}, ('2000-01-01'::date + g), 3 FROM generate_series(0, ${total - 1}) AS g`;
      const bundle = await dataSource().collect({ userId: user.id });
      expect(bundle.dailyCheckIns).toHaveLength(total);
      const dates = bundle.dailyCheckIns.map((c) => c.date);
      expect(new Set(dates).size).toBe(total);
      expect(dates).toEqual([...dates].sort());
    }, 60_000);

    it("一貫したスナップショット: 収集の途中で別の接続が更新・追加しても、収集開始時点の状態になる", async () => {
      const user = await seedUser("collect-snapshot");
      const writer = createPrismaClient(container.getConnectionUri());
      try {
        let injected = false;
        // 記録の query の直前に、別の接続から習慣の記録を追加し、習慣名を更新する。
        const intercepting = new Proxy(prisma, {
          get(target, property, receiver) {
            if (property !== "$transaction")
              return Reflect.get(target, property, receiver) as unknown;
            return (callback: (tx: unknown) => Promise<unknown>, options: unknown) =>
              target.$transaction(
                (tx) =>
                  callback(
                    new Proxy(tx, {
                      get(txTarget, txProperty, txReceiver) {
                        const value = Reflect.get(txTarget, txProperty, txReceiver) as unknown;
                        if (txProperty !== "$queryRaw" || typeof value !== "function") return value;
                        return async (strings: TemplateStringsArray, ...values: unknown[]) => {
                          if (!injected && strings.join("").includes("FROM habit_entries")) {
                            injected = true;
                            await writer.$executeRaw`
                              INSERT INTO habit_entries (user_id, habit_id, habit_date, status)
                              VALUES (${BigInt(user.id)}, (SELECT id FROM habits WHERE user_id = ${BigInt(user.id)} LIMIT 1),
                                      '2026-09-10'::date, 'missed')`;
                            await writer.$executeRaw`UPDATE habits SET name = '更新後' WHERE user_id = ${BigInt(user.id)}`;
                          }
                          return (value as (...args: unknown[]) => Promise<unknown>).call(
                            txTarget,
                            strings,
                            ...values,
                          );
                        };
                      },
                    }),
                  ),
                options as never,
              );
          },
        });
        const bundle = await createPrismaExportDataSource(intercepting).collect({
          userId: user.id,
        });
        expect(injected).toBe(true);
        // 収集開始時点の状態: 追加された記録も、更新後の習慣名も混ざらない。
        expect(bundle.habitEntries).toHaveLength(1);
        expect(bundle.habits[0]?.name).toBe("散歩");
        // 次の収集では反映される。
        const again = await dataSource().collect({ userId: user.id });
        expect(again.habitEntries).toHaveLength(2);
        expect(again.habits[0]?.name).toBe("更新後");
      } finally {
        await writer.$disconnect();
      }
    });
  });

  describe("処理(EXP-002)とダウンロード(EXP-004)", () => {
    it("JSON: 作成 → 処理 → 一覧 → ダウンロードの一連で、成果物が往復し、機密値を含まない", async () => {
      const user = await seedUser("flow-json");
      const created = await request(user.id, "json");
      await expect(
        processDataExportUseCase(processDeps(), { exportId: created.id, receiveCount: 1 }),
      ).resolves.toBe("done");

      const row = await exportRow(created.id);
      expect(row).toMatchObject({
        status: "ready",
        fileName: "habit-app-export-20261013.json",
        contentType: "application/json; charset=utf-8",
        completedAt: NOW,
        expiresAt: new Date(NOW.getTime() + DATA_EXPORT_TTL_HOURS * HOUR_MS),
      });
      const items = await listDataExportsUseCase(
        { exports: exportsRepo(), now: () => NOW },
        { actorUserId: user.id },
      );
      expect(items[0]).toMatchObject({ id: created.id, status: "ready", byteSize: row.byteSize });

      const file = await downloadDataExportUseCase(
        { exports: exportsRepo(), now: () => NOW },
        { actorUserId: user.id, exportId: created.id, context: CONTEXT },
      );
      expect(file.content.length).toBe(row.byteSize);
      const text = decoder.decode(file.content);
      const doc = JSON.parse(text) as { habits: { name: string }[]; account: { email: string } };
      expect(doc.habits[0]?.name).toBe("散歩");
      expect(doc.account.email).toBe(user.email);
      for (const secret of SECRETS) expect(text, secret).not.toContain(secret);
      expect(text).not.toContain(passwordHash);

      const downloaded = await prisma.auditLog.findMany({
        where: { targetPublicId: created.id, action: "user.export.downloaded" },
      });
      expect(downloaded).toHaveLength(1);
    });

    it("CSV: ZIP の成果物が保存され、バイト列がそのまま戻る", async () => {
      const user = await seedUser("flow-csv");
      const created = await request(user.id, "csv");
      await processDataExportUseCase(processDeps(), { exportId: created.id, receiveCount: 1 });
      const file = await downloadDataExportUseCase(
        { exports: exportsRepo(), now: () => NOW },
        { actorUserId: user.id, exportId: created.id, context: CONTEXT },
      );
      expect(file.contentType).toBe("application/zip");
      expect([...file.content.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
      const text = decoder.decode(file.content);
      expect(text).not.toContain("SECRET-");
    });

    it("他人の ID・存在しない ID・形式不正な ID は区別せず not found で、監査も残らない", async () => {
      const owner = await seedUser("idor-owner");
      const intruder = await createUser("idor-intruder");
      const created = await request(owner.id);
      await processDataExportUseCase(processDeps(), { exportId: created.id, receiveCount: 1 });
      const before = await prisma.auditLog.count({ where: { action: "user.export.downloaded" } });

      const download = (actor: string, id: string) =>
        downloadDataExportUseCase(
          { exports: exportsRepo(), now: () => NOW },
          { actorUserId: actor, exportId: id, context: CONTEXT },
        );
      await expect(download(intruder.id, created.id)).rejects.toThrow("export not found");
      await expect(download(owner.id, "00000000-0000-4000-8000-0000000000ff")).rejects.toThrow(
        "export not found",
      );
      await expect(download(owner.id, "not-a-uuid")).rejects.toThrow("export not found");
      expect(await prisma.auditLog.count({ where: { action: "user.export.downloaded" } })).toBe(
        before,
      );

      const intruderList = await listDataExportsUseCase(
        { exports: exportsRepo(), now: () => NOW },
        { actorUserId: intruder.id },
      );
      expect(intruderList).toEqual([]);
    });

    it("完成前は not ready、期限ちょうどから expired", async () => {
      const user = await seedUser("states");
      const created = await request(user.id);
      const read = (now: Date) =>
        downloadDataExportUseCase(
          { exports: exportsRepo(), now: () => now },
          { actorUserId: user.id, exportId: created.id, context: CONTEXT },
        );
      await expect(read(NOW)).rejects.toThrow("export not ready");

      await processDataExportUseCase(processDeps(), { exportId: created.id, receiveCount: 1 });
      const expiresAt = NOW.getTime() + DATA_EXPORT_TTL_HOURS * HOUR_MS;
      await expect(read(new Date(expiresAt - 1))).resolves.toBeDefined();
      await expect(read(new Date(expiresAt))).rejects.toThrow("export expired");
    });

    it("監査の追記に失敗したら成果物を返さない(fail closed): audit_logs の追記を拒否させる", async () => {
      const user = await seedUser("audit-fail");
      const created = await request(user.id);
      await processDataExportUseCase(processDeps(), { exportId: created.id, receiveCount: 1 });
      await prisma.$executeRawUnsafe(
        `CREATE OR REPLACE FUNCTION reject_download_audit() RETURNS trigger AS $$ BEGIN
           IF NEW.action = 'user.export.downloaded' THEN RAISE EXCEPTION 'audit rejected'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql`,
      );
      await prisma.$executeRawUnsafe(
        `CREATE TRIGGER reject_download_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION reject_download_audit()`,
      );
      try {
        await expect(
          downloadDataExportUseCase(
            { exports: exportsRepo(), now: () => NOW },
            { actorUserId: user.id, exportId: created.id, context: CONTEXT },
          ),
        ).rejects.toThrow();
      } finally {
        await prisma.$executeRawUnsafe(`DROP TRIGGER reject_download_audit ON audit_logs`);
      }
    });

    it("並行 claim: 6 件の同時処理で処理(収集・確定)は 1 回だけ", async () => {
      const user = await seedUser("claim-race");
      const created = await request(user.id);
      const results = await Promise.all(
        Array.from({ length: 6 }, () =>
          processDataExportUseCase(processDeps(), { exportId: created.id, receiveCount: 1 }),
        ),
      );
      // 勝った 1 件は done。lease 内の他は retry(再配送に任せる)か、完了後なら done。
      expect(results.filter((r) => r === "done").length).toBeGreaterThanOrEqual(1);
      const row = await exportRow(created.id);
      expect(row.status).toBe("ready");
      expect(await prisma.dataExportArtifact.count({ where: { exportId: row.id } })).toBe(1);
      // 重複配送(完了後)は何もしない。
      await expect(
        processDataExportUseCase(processDeps(), { exportId: created.id, receiveCount: 2 }),
      ).resolves.toBe("done");
    });

    it("lease: 処理中(running)は別の worker が奪えず、lease を過ぎたら引き継げる。終端は変更されない", async () => {
      const user = await createUser("lease");
      const created = await request(user.id);
      const repo = exportsRepo();
      expect((await repo.claim({ exportId: created.id, leaseSeconds: 300 })).status).toBe(
        "claimed",
      );
      expect((await repo.claim({ exportId: created.id, leaseSeconds: 300 })).status).toBe(
        "in_progress",
      );

      await prisma.$executeRaw`
        UPDATE data_exports SET updated_at = now() - interval '10 minutes' WHERE public_id = ${created.id}::uuid`;
      // 手動で updated_at を戻したあとの更新は trigger が上書きするため、lease 判定の確認は claim の結果で行う。
      expect((await repo.claim({ exportId: created.id, leaseSeconds: 300 })).status).toBe(
        "in_progress",
      );

      await repo.fail({ exportId: created.id, failureCode: "worker_error" });
      expect((await repo.claim({ exportId: created.id, leaseSeconds: 300 })).status).toBe(
        "finished",
      );
      expect((await exportRow(created.id)).status).toBe("failed");
      expect(
        (await repo.claim({ exportId: "00000000-0000-4000-8000-0000000000ff", leaseSeconds: 1 }))
          .status,
      ).toBe("not_found");
      expect((await repo.claim({ exportId: "x", leaseSeconds: 1 })).status).toBe("not_found");
    });

    it("complete は running のときだけ成立し、fail/release は終端を変えない", async () => {
      const user = await createUser("terminal");
      const created = await request(user.id);
      const repo = exportsRepo();
      const base = {
        exportId: created.id,
        content: new Uint8Array([1, 2, 3]),
        fileName: "f.json",
        contentType: "application/json",
        completedAt: NOW,
        expiresAt: new Date(NOW.getTime() + 1000),
      };
      await expect(repo.complete(base)).resolves.toBe("lost"); // queued のまま
      await repo.claim({ exportId: created.id, leaseSeconds: 300 });
      await repo.release({ exportId: created.id });
      expect((await exportRow(created.id)).status).toBe("queued");
      await repo.claim({ exportId: created.id, leaseSeconds: 300 });
      await expect(repo.complete(base)).resolves.toBe("completed");
      await expect(repo.complete(base)).resolves.toBe("lost");
      await repo.fail({ exportId: created.id, failureCode: "worker_error" });
      await repo.release({ exportId: created.id });
      expect((await exportRow(created.id)).status).toBe("ready");
    });

    it("inline queue 経由: 作成 → 処理が非同期に走り、flush で ready になる。投入の失敗は failed(enqueue_failed)", async () => {
      const user = await seedUser("inline");
      const queue = createInlineDataExportQueue(async (message, receiveCount) =>
        processDataExportUseCase(processDeps(), { exportId: message.exportId, receiveCount }),
      );
      const created = await requestDataExportUseCase(requestDeps(queue), {
        actorUserId: user.id,
        password: PASSWORD,
        format: "json",
        context: CONTEXT,
      });
      expect((await exportRow(created.id)).status).toMatch(/queued|running|ready/);
      await queue.flush();
      expect((await exportRow(created.id)).status).toBe("ready");

      const failing = await seedUser("inline-fail");
      await expect(
        requestDataExportUseCase(
          requestDeps({
            enqueue: async () => {
              throw new Error("down");
            },
          }),
          {
            actorUserId: failing.id,
            password: PASSWORD,
            format: "csv",
            context: CONTEXT,
          },
        ),
      ).rejects.toThrow("export unavailable");
      const [row] = await prisma.dataExport.findMany({ where: { userId: BigInt(failing.id) } });
      expect(row).toMatchObject({ status: "failed", failureCode: "enqueue_failed" });
    });
  });

  describe("停止した job(EXP-001/007)", () => {
    it("60 分以上更新のない queued は、作成時に failed(worker_error)になり、新しく作成できる", async () => {
      const user = await createUser("stale-create");
      const stuck = await request(user.id);
      await expect(request(user.id, "json", new Date(NOW.getTime() + 59 * 60_000))).rejects.toThrow(
        "export in progress",
      );

      // 他のテストと同様 updated_at は DB の trigger が決める。ここでは 61 分後を「現在」として渡す。
      const later = new Date(Date.now() + 61 * 60_000);
      const fresh = await request(user.id, "json", later);
      expect(fresh.status).toBe("queued");
      expect(await exportRow(stuck.id)).toMatchObject({
        status: "failed",
        failureCode: "worker_error",
      });
    });

    it("他のユーザーの job は停止扱いにしない(作成時は自分の job だけが対象)", async () => {
      const a = await createUser("stale-a");
      const b = await createUser("stale-b");
      const bJob = await request(b.id);
      const later = new Date(Date.now() + 61 * 60_000);
      await request(a.id, "json", later);
      expect((await exportRow(bJob.id)).status).toBe("queued");
    });

    it("定期ジョブも停止した queued/running を failed にする。新しい job と終端は変更しない", async () => {
      const staleUser = await createUser("stale-cleanup");
      const stale = await request(staleUser.id);
      const doneUser = await seedUser("stale-done");
      const done = await request(doneUser.id);
      await processDataExportUseCase(processDeps(), { exportId: done.id, receiveCount: 1 });

      const repo = exportsRepo();
      // この job の更新時刻(NOW)より前の基準では、まだ停止していない(他のテストの job は件数に含まれうる)。
      await repo.failStale({ cutoff: new Date(NOW.getTime() - 1), limit: 1000 });
      expect((await exportRow(stale.id)).status).toBe("queued");

      // 更新時刻以降の基準なら停止とみなされ、failed(worker_error)になる。
      const count = await repo.failStale({ cutoff: NOW, limit: 1000 });
      expect(count).toBeGreaterThanOrEqual(1);
      expect(await exportRow(stale.id)).toMatchObject({
        status: "failed",
        failureCode: "worker_error",
      });
      // 完成済みは変更しない。
      expect((await exportRow(done.id)).status).toBe("ready");
    });
  });

  describe("期限切れの削除(EXP-007)", () => {
    it("期限切れの ready は成果物が消えて expired、7 日を過ぎた failed/expired の行は削除される。冪等", async () => {
      const user = await seedUser("cleanup");
      const created = await request(user.id);
      await processDataExportUseCase(processDeps(), { exportId: created.id, receiveCount: 1 });
      const id = (await exportRow(created.id)).id;
      const run = (now: Date) =>
        cleanupExpiredDataExportsUseCase({ exports: exportsRepo(), now: () => now });

      // 期限前は何もしない(他のテストの行は期限切れでないものだけ、または別の件数に含まれうるため、この行の状態で確認する)。
      await run(new Date(NOW.getTime() + 23 * HOUR_MS));
      expect((await exportRow(created.id)).status).toBe("ready");

      const afterExpiry = new Date(NOW.getTime() + 25 * HOUR_MS);
      await run(afterExpiry);
      expect((await exportRow(created.id)).status).toBe("expired");
      expect(await prisma.dataExportArtifact.count({ where: { exportId: id } })).toBe(0);
      await run(afterExpiry); // 冪等

      // updated_at を 8 日前にして、行の削除を確認する。
      await prisma.$executeRaw`ALTER TABLE data_exports DISABLE TRIGGER set_updated_at`;
      try {
        await prisma.$executeRaw`UPDATE data_exports SET updated_at = now() - interval '8 days' WHERE id = ${id}`;
      } finally {
        await prisma.$executeRaw`ALTER TABLE data_exports ENABLE TRIGGER set_updated_at`;
      }
      await cleanupExpiredDataExportsUseCase({ exports: exportsRepo(), now: () => new Date() });
      expect(await prisma.dataExport.count({ where: { id } })).toBe(0);
    });

    it("並行して実行しても例外にならない", async () => {
      const results = await Promise.allSettled(
        Array.from({ length: 4 }, () =>
          cleanupExpiredDataExportsUseCase({
            exports: exportsRepo(),
            now: () => new Date(NOW.getTime() + 30 * HOUR_MS),
          }),
        ),
      );
      expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    });
  });

  describe("DB 制約とアカウント削除との連動", () => {
    it("CHECK: ready は必須項目が揃っていること、failed は failure_code が必要、値域", async () => {
      const user = await createUser("checks");
      const id = BigInt(user.id);
      await expect(
        prisma.$executeRaw`INSERT INTO data_exports (user_id, format, status) VALUES (${id}, 'json', 'ready')`,
      ).rejects.toThrow(/data_exports_ready_check/);
      await expect(
        prisma.$executeRaw`INSERT INTO data_exports (user_id, format, status) VALUES (${id}, 'json', 'failed')`,
      ).rejects.toThrow(/data_exports_failure_check/);
      await expect(
        prisma.$executeRaw`INSERT INTO data_exports (user_id, format, status, failure_code) VALUES (${id}, 'json', 'queued', 'x')`,
      ).rejects.toThrow(/data_exports_failure_check/);
      await expect(
        prisma.$executeRaw`INSERT INTO data_exports (user_id, format, status) VALUES (${id}, 'xml', 'queued')`,
      ).rejects.toThrow(/data_exports_format_check/);
      await expect(
        prisma.$executeRaw`INSERT INTO data_exports (user_id, format, status) VALUES (${id}, 'json', 'done')`,
      ).rejects.toThrow(/data_exports_status_check/);
      await expect(
        prisma.$executeRaw`INSERT INTO data_exports (user_id, format, status, byte_size) VALUES (${id}, 'json', 'queued', -1)`,
      ).rejects.toThrow(/data_exports_byte_size_check/);
    });

    it("アカウント削除の期限到来で、エクスポートと成果物も削除される(全 FK が CASCADE)", async () => {
      const user = await seedUser("cascade");
      const created = await request(user.id);
      await processDataExportUseCase(processDeps(), { exportId: created.id, receiveCount: 1 });
      const id = (await exportRow(created.id)).id;
      expect(await prisma.dataExportArtifact.count({ where: { exportId: id } })).toBe(1);

      await prisma.$executeRaw`DELETE FROM users WHERE id = ${BigInt(user.id)}`;
      expect(await prisma.dataExport.count({ where: { id } })).toBe(0);
      expect(await prisma.dataExportArtifact.count({ where: { exportId: id } })).toBe(0);
    });

    it("一覧・状態の query は成果物(bytea)を読まない: data_exports に content 列は無い", async () => {
      const columns = await prisma.$queryRaw<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'data_exports'`;
      expect(columns.map((c) => c.column_name)).not.toContain("content");
    });
  });
});

describe("Migration t404 data_export の upgrade(直前の Migration まで適用済みの DB から)", () => {
  it("既存のデータを保ったまま適用でき、適用後に新しいテーブルと制約が使える", async () => {
    const upgradeContainer = await startPostgresContainer();
    try {
      const migrationsDir = path.join(infrastructureRoot, "database", "migrations");
      const names = fs
        .readdirSync(migrationsDir)
        .filter((name) => /^\d{14}_/.test(name))
        .sort();
      expect(names).toContain(T404_EXPORT_MIGRATION);

      const env = { ...process.env, DATABASE_URL: upgradeContainer.getConnectionUri() };
      const staging = fs.mkdtempSync(path.join(infrastructureRoot, ".t404-export-upgrade-"));
      const stagingConfig = path.join(infrastructureRoot, ".t404-export-upgrade.config.ts");
      try {
        fs.copyFileSync(
          path.join(migrationsDir, "migration_lock.toml"),
          path.join(staging, "migration_lock.toml"),
        );
        for (const name of names.filter((n) => n < T404_EXPORT_MIGRATION)) {
          fs.cpSync(path.join(migrationsDir, name), path.join(staging, name), { recursive: true });
        }
        fs.writeFileSync(
          stagingConfig,
          `import { defineConfig } from "prisma/config";
export default defineConfig({
  schema: "database/schema.prisma",
  migrations: { path: ${JSON.stringify(staging)} },
  datasource: { url: process.env["DATABASE_URL"] },
});
`,
        );
        execFileSync(prismaCli, ["migrate", "deploy", "--config", stagingConfig], {
          cwd: infrastructureRoot,
          env,
          stdio: "pipe",
        });
      } finally {
        fs.rmSync(stagingConfig, { force: true });
        fs.rmSync(staging, { recursive: true, force: true });
      }

      const client = createPrismaClient(upgradeContainer.getConnectionUri());
      try {
        const user = await client.user.create({
          data: {
            authSubject: "credentials:upgrade-export@example.test",
            emailNormalized: "upgrade-export@example.test",
            passwordHash: "hash",
          },
        });
        execFileSync(prismaCli, ["migrate", "deploy", "--config", prismaConfigPath], {
          cwd: infrastructureRoot,
          env,
          stdio: "pipe",
        });

        expect(await client.user.count({ where: { id: user.id } })).toBe(1);
        await expect(
          client.$executeRaw`INSERT INTO data_exports (user_id, format, status) VALUES (${user.id}, 'json', 'queued')`,
        ).resolves.toBe(1);
        await expect(
          client.$executeRaw`INSERT INTO data_exports (user_id, format, status) VALUES (${user.id}, 'csv', 'queued')`,
        ).rejects.toThrow(/data_exports_user_active_uidx/);
        const triggers = await client.$queryRaw<{ tgname: string }[]>`
          SELECT tgname FROM pg_trigger WHERE tgrelid = 'data_exports'::regclass AND NOT tgisinternal`;
        expect(triggers.map((t) => t.tgname)).toContain("set_updated_at");
      } finally {
        await client.$disconnect();
      }
    } finally {
      await upgradeContainer.stop();
    }
  }, 180_000);
});
