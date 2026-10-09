import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  deliverReminderUseCase,
  handleEmailFeedbackUseCase,
  scheduleDueRemindersUseCase,
  unsubscribeUseCase,
} from "@habit-app/application";
import type { ReminderEmail, ReminderQueuePort } from "@habit-app/application";
import { REMINDER_MAX_ATTEMPTS } from "@habit-app/domain";
import { startPostgresContainer } from "@habit-app/test-support";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient, type PrismaClient } from "../database/prisma-client";
import { createHmacUnsubscribeTokenSigner } from "./hmac-unsubscribe-token";
import {
  createPrismaEmailSuppressionRepository,
  createPrismaRecipientRepository,
} from "./prisma-email-suppression-repository";
import { createPrismaNotificationSettingsRepository } from "./prisma-notification-settings-repository";
import { createPrismaReminderDeliveryRepository } from "./prisma-reminder-delivery-repository";

import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const infrastructureRoot = path.resolve(__dirname, "../../");
const prismaConfigPath = path.join(infrastructureRoot, "prisma.config.ts");
const prismaCli = path.join(infrastructureRoot, "node_modules", ".bin", "prisma");
const T402_MIGRATION = "20261009000000_t402_notification_delivery";

// 東京 2026-01-15 08:02(送信枠 08:00 の 2 分後)
const NOW = new Date("2026-01-14T23:02:00.000Z");
const SLOT = new Date("2026-01-14T23:00:00.000Z");
// テスト用のダミー値(低エントロピーの繰り返し。実際の鍵ではない)。
const SIGNING_KEY = "s".repeat(40);

describe("通知の配送 repository 群(T-402)", () => {
  let container: StartedPostgreSqlContainer;
  let prisma: PrismaClient;

  const deliveries = () => createPrismaReminderDeliveryRepository(prisma);
  const suppressions = () => createPrismaEmailSuppressionRepository(prisma);

  async function createUser(label: string, verified = true) {
    const user = await prisma.user.create({
      data: {
        authSubject: `credentials:${label}@example.com`,
        emailNormalized: `${label}@example.com`,
        passwordHash: "hash",
        emailVerifiedAt: verified ? NOW : null,
      },
    });
    return { id: user.id.toString(), publicId: user.publicId };
  }

  async function createSetting(
    userId: string,
    options: { localTime?: string; timezone?: string; enabled?: boolean } = {},
  ): Promise<string> {
    const rows = await prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO notification_settings (user_id, local_time, timezone, enabled)
      VALUES (${BigInt(userId)}, ${options.localTime ?? "08:00"}::time,
              ${options.timezone ?? "Asia/Tokyo"}, ${options.enabled ?? true})
      RETURNING id::text AS id`;
    return rows[0]?.id ?? "";
  }

  const scanSetting = (settingId: string, userId: string) => ({
    settingId,
    userId,
    localTime: "08:00",
    timezone: "Asia/Tokyo",
  });

  async function createPending(
    settingId: string,
    userId: string,
    key: string,
    localDate = "2026-01-15",
  ) {
    await deliveries().createPendingIfAbsent({
      setting: scanSetting(settingId, userId),
      localDate,
      scheduledAt: SLOT,
      deduplicationKey: key,
      now: NOW,
    });
    const rows = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id::text AS id FROM notification_deliveries WHERE deduplication_key = ${key}`;
    return rows[0]?.id ?? "";
  }

  const rowOf = async (id: string) =>
    (
      await prisma.$queryRaw<
        {
          status: string;
          attempt_count: number;
          failure_code: string | null;
          provider_message_id: string | null;
          sent_at: Date | null;
          locked_until: Date | null;
          enqueued_at: Date | null;
        }[]
      >`SELECT status, attempt_count, failure_code, provider_message_id, sent_at, locked_until, enqueued_at
        FROM notification_deliveries WHERE id = ${BigInt(id)}`
    )[0];

  beforeAll(async () => {
    container = await startPostgresContainer();
    execFileSync(prismaCli, ["migrate", "deploy", "--config", prismaConfigPath], {
      cwd: infrastructureRoot,
      env: { ...process.env, DATABASE_URL: container.getConnectionUri() },
      stdio: "pipe",
    });
    prisma = createPrismaClient(container.getConnectionUri());
  }, 120_000);

  afterAll(async () => {
    await prisma.$disconnect();
    await container.stop();
  }, 60_000);

  it("有効なユーザー単位の email 設定だけを id の昇順でページング走査する", async () => {
    const u1 = await createUser("scan-1");
    const u2 = await createUser("scan-2");
    const u3 = await createUser("scan-3");
    const s1 = await createSetting(u1.id);
    await createSetting(u2.id, { enabled: false });
    const s3 = await createSetting(u3.id, { localTime: "21:30", timezone: "America/New_York" });
    const habit = await prisma.habit.create({
      data: {
        publicId: "00000000-0000-4000-8000-000000000501",
        userId: BigInt(u1.id),
        kind: "build",
        name: "習慣",
        purpose: "テスト",
        cue: "テスト",
        minimumAction: "テスト",
        status: "active",
      },
    });
    const habitScoped = await prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO notification_settings (user_id, habit_id, local_time, timezone, enabled)
      VALUES (${BigInt(u1.id)}, ${habit.id}, '06:00'::time, 'Asia/Tokyo', true)
      RETURNING id::text AS id`;
    const habitScopedId = habitScoped[0]?.id ?? "";

    const all = await deliveries().listEnabledSettings({ afterSettingId: null, limit: 100 });
    const mine = all.filter((s) => [s1, s3].includes(s.settingId));
    expect(mine.map((s) => s.settingId)).toEqual([s1, s3]);
    expect(mine[1]).toMatchObject({ localTime: "21:30", timezone: "America/New_York" });
    // 習慣ごとの設定・無効な設定は含まれない。
    expect(all.every((s) => s.userId !== u2.id)).toBe(true);
    expect(all.map((s) => s.settingId)).not.toContain(habitScopedId);

    const page1 = await deliveries().listEnabledSettings({ afterSettingId: null, limit: 1 });
    const page2 = await deliveries().listEnabledSettings({
      afterSettingId: page1[0]?.settingId ?? null,
      limit: 1,
    });
    expect(BigInt(page2[0]?.settingId ?? "0")).toBeGreaterThan(BigInt(page1[0]?.settingId ?? "0"));
  });

  it("同じ dedupe キーへの作成は並行 6 件でも 1 行。存在しない設定は作らない", async () => {
    const user = await createUser("dedupe");
    const settingId = await createSetting(user.id);
    const results = await Promise.all(
      [1, 2, 3, 4, 5, 6].map(() =>
        deliveries().createPendingIfAbsent({
          setting: scanSetting(settingId, user.id),
          localDate: "2026-01-15",
          scheduledAt: SLOT,
          deduplicationKey: `reminder:${settingId}:2026-01-15`,
          now: NOW,
        }),
      ),
    );
    expect(results.filter((r) => r.created)).toHaveLength(1);
    const count = await prisma.notificationDelivery.count({ where: { userId: BigInt(user.id) } });
    expect(count).toBe(1);

    const ghost = await deliveries().createPendingIfAbsent({
      setting: scanSetting("999999", user.id),
      localDate: "2026-01-15",
      scheduledAt: SLOT,
      deduplicationKey: "reminder:999999:2026-01-15",
      now: NOW,
    });
    expect(ghost.created).toBe(false);
  });

  it("claim は並行 6 件で 1 回だけ成功し、attempt_count と lease を設定する。lease 中・時刻前・上限超過は取得できない", async () => {
    const user = await createUser("claim");
    const settingId = await createSetting(user.id);
    const id = await createPending(settingId, user.id, `reminder:${settingId}:2026-01-15`);
    const leaseUntil = new Date(NOW.getTime() + 300_000);

    const claims = await Promise.all(
      [1, 2, 3, 4, 5, 6].map(() => deliveries().claim({ deliveryId: id, now: NOW, leaseUntil })),
    );
    expect(claims.filter((c) => c !== null)).toHaveLength(1);
    expect(claims.find((c) => c !== null)).toMatchObject({
      id,
      userId: user.id,
      localDate: "2026-01-15",
      attemptCount: 1,
    });
    expect(claims.find((c) => c !== null)?.scheduledAt).toEqual(SLOT);

    // lease 中は取得できず、lease 切れ後は取得できる(attempt が増える)。
    expect(await deliveries().claim({ deliveryId: id, now: NOW, leaseUntil })).toBeNull();
    const afterLease = new Date(leaseUntil.getTime() + 1);
    const again = await deliveries().claim({ deliveryId: id, now: afterLease, leaseUntil });
    expect(again?.attemptCount).toBe(2);

    // next_attempt_at が未来なら取得できない。
    const later = await createPending(
      settingId,
      user.id,
      `reminder:${settingId}:2026-01-16`,
      "2026-01-16",
    );
    await prisma.$executeRaw`
      UPDATE notification_deliveries SET next_attempt_at = ${new Date(NOW.getTime() + 60_000)}
      WHERE id = ${BigInt(later)}`;
    expect(await deliveries().claim({ deliveryId: later, now: NOW, leaseUntil })).toBeNull();

    // 形式不正な ID は何にも到達しない。
    expect(await deliveries().claim({ deliveryId: "abc", now: NOW, leaseUntil })).toBeNull();
  });

  it("試行が上限に達した pending は claim できず、failExhausted で failed になる", async () => {
    const user = await createUser("exhaust");
    const settingId = await createSetting(user.id);
    const id = await createPending(settingId, user.id, `reminder:${settingId}:2026-01-15`);
    await prisma.$executeRaw`
      UPDATE notification_deliveries
      SET attempt_count = ${REMINDER_MAX_ATTEMPTS}, locked_until = ${new Date(NOW.getTime() - 1)}
      WHERE id = ${BigInt(id)}`;
    expect(
      await deliveries().claim({
        deliveryId: id,
        now: NOW,
        leaseUntil: new Date(NOW.getTime() + 1000),
      }),
    ).toBeNull();
    expect(await deliveries().failExhausted({ now: NOW })).toBeGreaterThanOrEqual(1);
    expect(await rowOf(id)).toMatchObject({ status: "failed", failure_code: "retries_exhausted" });
  });

  it("finalize は pending だけを終端にし、終端の行は更新しない。sent は sent_at と message ID を記録する", async () => {
    const user = await createUser("finalize");
    const settingId = await createSetting(user.id);
    const id = await createPending(settingId, user.id, `reminder:${settingId}:2026-01-15`);

    expect(
      await deliveries().finalize({
        deliveryId: id,
        status: "sent",
        failureCode: null,
        providerMessageId: "ses-final-1",
        now: NOW,
      }),
    ).toBe(true);
    expect(await rowOf(id)).toMatchObject({
      status: "sent",
      provider_message_id: "ses-final-1",
      sent_at: NOW,
      locked_until: null,
    });

    // 終端の行は変更されない(failed への上書きも、再度の sent も)。
    for (const status of ["failed", "sent", "expired"] as const) {
      expect(
        await deliveries().finalize({
          deliveryId: id,
          status,
          failureCode: "x",
          providerMessageId: "other",
          now: NOW,
        }),
      ).toBe(false);
    }
    expect(await rowOf(id)).toMatchObject({ status: "sent", provider_message_id: "ses-final-1" });
    // 終端の行は claim も retry もできない。
    expect(
      await deliveries().claim({
        deliveryId: id,
        now: NOW,
        leaseUntil: new Date(NOW.getTime() + 1),
      }),
    ).toBeNull();
    await deliveries().scheduleRetry({
      deliveryId: id,
      nextAttemptAt: NOW,
      failureCode: "x",
      now: NOW,
    });
    expect((await rowOf(id))?.status).toBe("sent");
  });

  it("再投入の候補は pending のうち、時刻に達しており未投入または古い投入のものだけ。markEnqueued 後は選ばれない", async () => {
    const user = await createUser("enqueue");
    const settingId = await createSetting(user.id);
    const a = await createPending(settingId, user.id, `reminder:${settingId}:2026-01-15`);
    const b = await createPending(
      settingId,
      user.id,
      `reminder:${settingId}:2026-01-16`,
      "2026-01-16",
    );
    const c = await createPending(
      settingId,
      user.id,
      `reminder:${settingId}:2026-01-17`,
      "2026-01-17",
    );
    await prisma.$executeRaw`UPDATE notification_deliveries SET next_attempt_at = ${new Date(NOW.getTime() + 60_000)} WHERE id = ${BigInt(c)}`;
    const requeueBefore = new Date(NOW.getTime() - 600_000);

    const first = await deliveries().listEnqueueCandidates({ now: NOW, requeueBefore, limit: 100 });
    expect(first).toContain(a);
    expect(first).toContain(b);
    expect(first).not.toContain(c);

    await deliveries().markEnqueued({ ids: [a, b], now: NOW });
    const second = await deliveries().listEnqueueCandidates({
      now: NOW,
      requeueBefore,
      limit: 100,
    });
    expect(second).not.toContain(a);
    expect(second).not.toContain(b);

    // 10 分以上たてば再投入の対象になり、終端になれば対象外。
    const later = new Date(NOW.getTime() + 11 * 60_000);
    const third = await deliveries().listEnqueueCandidates({
      now: later,
      requeueBefore: new Date(later.getTime() - 600_000),
      limit: 100,
    });
    expect(third).toContain(a);
    await deliveries().finalize({
      deliveryId: a,
      status: "expired",
      failureCode: null,
      providerMessageId: null,
      now: later,
    });
    const fourth = await deliveries().listEnqueueCandidates({
      now: later,
      requeueBefore: new Date(later.getTime() - 600_000),
      limit: 100,
    });
    expect(fourth).not.toContain(a);
    expect(fourth).toContain(b);
  });

  it("スケジューラ→ワーカーを実 DB で通す: 1 回だけ送信され、再実行・再処理でも重複しない", async () => {
    const user = await createUser("flow");
    const settingId = await createSetting(user.id);
    const sent: ReminderEmail[] = [];
    const enqueued: string[] = [];
    const queue: ReminderQueuePort = {
      async enqueue(ids) {
        enqueued.push(...ids);
        return ids;
      },
    };
    const schedule = () =>
      scheduleDueRemindersUseCase({ deliveryRepository: deliveries(), queue, now: () => NOW });
    await schedule();
    await schedule();

    const mine = await prisma.notificationDelivery.findMany({
      where: { userId: BigInt(user.id) },
    });
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      status: "pending",
      localDate: new Date("2026-01-15T00:00:00Z"),
    });
    const deliveryId = mine[0]?.id.toString() ?? "";
    expect(enqueued.filter((id) => id === deliveryId)).toHaveLength(1);

    const deps = {
      deliveryRepository: deliveries(),
      settingsRepository: createPrismaNotificationSettingsRepository(prisma),
      suppressions: suppressions(),
      recipients: createPrismaRecipientRepository(prisma),
      emailSender: {
        async send(email: ReminderEmail) {
          sent.push(email);
          return { providerMessageId: `ses-flow-${sent.length}` };
        },
      },
      unsubscribeTokens: createHmacUnsubscribeTokenSigner(SIGNING_KEY),
      hasUnrecordedSchedule: async () => true,
      random: () => 0.5,
      now: () => NOW,
      appBaseUrl: "https://app.example.test",
    };
    const outcomes = await Promise.all(
      [1, 2, 3, 4, 5, 6].map(() => deliverReminderUseCase(deps, { deliveryId })),
    );
    expect(outcomes.filter((o) => o === "sent")).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe("flow@example.com");
    expect(await deliverReminderUseCase(deps, { deliveryId })).toBe("noop");
    expect(await rowOf(deliveryId)).toMatchObject({
      status: "sent",
      provider_message_id: "ses-flow-1",
    });

    // bounce の通知で suppression され、設定を再度有効にしても次の配送は送られない。
    await handleEmailFeedbackUseCase(
      { deliveryRepository: deliveries(), suppressions: suppressions(), now: () => NOW },
      { kind: "bounce_permanent", providerMessageId: "ses-flow-1" },
    );
    const next = await createPending(
      settingId,
      user.id,
      `reminder:${settingId}:2026-01-16`,
      "2026-01-16",
    );
    await prisma.$executeRaw`UPDATE notification_deliveries SET scheduled_at = ${SLOT} WHERE id = ${BigInt(next)}`;
    expect(await deliverReminderUseCase(deps, { deliveryId: next })).toBe("suppressed");
    expect(sent).toHaveLength(1);
  });

  it("suppression は冪等で、存在しないユーザーは記録せず、CASCADE でユーザーと一緒に消える", async () => {
    const user = await createUser("suppress");
    const repo = suppressions();
    expect(await repo.isSuppressed(user.id)).toBe(false);
    await repo.suppress({ userId: user.id, reason: "bounce", now: NOW });
    await repo.suppress({ userId: user.id, reason: "complaint", now: NOW });
    expect(await repo.isSuppressed(user.id)).toBe(true);
    const rows = await prisma.emailSuppression.findMany({ where: { userId: BigInt(user.id) } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reason).toBe("bounce"); // 先に記録された理由を保つ

    const before = await prisma.emailSuppression.count();
    await repo.suppress({ userId: "999999", reason: "bounce", now: NOW });
    await repo.suppress({ userId: "abc", reason: "bounce", now: NOW });
    expect(await prisma.emailSuppression.count()).toBe(before);

    const settingId = await createSetting(user.id);
    await createPending(settingId, user.id, `reminder:${settingId}:2026-01-15`);
    await prisma.user.delete({ where: { id: BigInt(user.id) } });
    expect(await prisma.emailSuppression.count({ where: { userId: BigInt(user.id) } })).toBe(0);
    expect(await prisma.notificationDelivery.count({ where: { userId: BigInt(user.id) } })).toBe(0);
  });

  it("宛先は有効かつ email 確認済みのユーザーだけ。公開 ID を返し、内部 ID は返さない", async () => {
    const ok = await createUser("recipient-ok");
    const unverified = await createUser("recipient-unverified", false);
    const suspended = await createUser("recipient-suspended");
    await prisma.$executeRaw`UPDATE users SET status = 'suspended' WHERE id = ${BigInt(suspended.id)}`;
    const repo = createPrismaRecipientRepository(prisma);
    expect(await repo.findRecipient(ok.id)).toEqual({
      email: "recipient-ok@example.com",
      userPublicId: ok.publicId,
    });
    expect(await repo.findRecipient(unverified.id)).toBeNull();
    expect(await repo.findRecipient(suspended.id)).toBeNull();
    expect(await repo.findRecipient("999999")).toBeNull();
  });

  it("配信停止は対象ユーザーの設定だけを無効にし、他の項目と他ユーザーは変えない。2 回目・不明な ID も成功", async () => {
    const a = await createUser("unsub-a");
    const b = await createUser("unsub-b");
    await createSetting(a.id, { localTime: "07:45", timezone: "Europe/London" });
    await createSetting(b.id);
    const settings = createPrismaNotificationSettingsRepository(prisma);
    const tokens = createHmacUnsubscribeTokenSigner(SIGNING_KEY);
    const deps = { unsubscribeTokens: tokens, settingsRepository: settings, now: () => NOW };

    expect(await unsubscribeUseCase(deps, { token: tokens.issue(a.publicId) })).toBe(
      "unsubscribed",
    );
    expect(await unsubscribeUseCase(deps, { token: tokens.issue(a.publicId) })).toBe(
      "unsubscribed",
    );
    expect(
      await unsubscribeUseCase(deps, {
        token: tokens.issue("3f2b8c1e-5a47-4d9e-8c36-1b2a9e7d4f10"),
      }),
    ).toBe("unsubscribed");
    expect(await unsubscribeUseCase(deps, { token: "garbage" })).toBe("invalid_token");

    expect(await settings.find({ actorUserId: a.id })).toMatchObject({
      enabled: false,
      localTime: "07:45",
      timezone: "Europe/London",
    });
    expect((await settings.find({ actorUserId: b.id }))?.enabled).toBe(true);
    await settings.disableByUserPublicId({ userPublicId: "not-a-uuid", now: NOW });
  });

  it("provider_message_id の一意制約と、feedback の引き当て", async () => {
    const user = await createUser("provider");
    const settingId = await createSetting(user.id);
    const first = await createPending(settingId, user.id, `reminder:${settingId}:2026-01-15`);
    const second = await createPending(
      settingId,
      user.id,
      `reminder:${settingId}:2026-01-16`,
      "2026-01-16",
    );
    await deliveries().finalize({
      deliveryId: first,
      status: "sent",
      failureCode: null,
      providerMessageId: "ses-dup-1",
      now: NOW,
    });
    expect(await deliveries().findUserIdByProviderMessageId("ses-dup-1")).toBe(user.id);
    expect(await deliveries().findUserIdByProviderMessageId("unknown")).toBeNull();
    await expect(
      deliveries().finalize({
        deliveryId: second,
        status: "sent",
        failureCode: null,
        providerMessageId: "ses-dup-1",
        now: NOW,
      }),
    ).rejects.toThrow();
  });

  it("DB の CHECK 制約: status、attempt_count、suppression の reason", async () => {
    const user = await createUser("checks");
    const settingId = await createSetting(user.id);
    const id = await createPending(settingId, user.id, `reminder:${settingId}:2026-01-15`);
    await expect(
      prisma.$executeRaw`UPDATE notification_deliveries SET status = 'unknown' WHERE id = ${BigInt(id)}`,
    ).rejects.toThrow();
    await expect(
      prisma.$executeRaw`UPDATE notification_deliveries SET attempt_count = 6 WHERE id = ${BigInt(id)}`,
    ).rejects.toThrow();
    await expect(
      prisma.$executeRaw`UPDATE notification_deliveries SET attempt_count = -1 WHERE id = ${BigInt(id)}`,
    ).rejects.toThrow();
    await expect(
      prisma.$executeRaw`INSERT INTO email_suppressions (user_id, reason) VALUES (${BigInt(user.id)}, 'spam')`,
    ).rejects.toThrow();
  });
});

describe("Migration t402 の upgrade(直前の Migration まで適用済みの DB から)", () => {
  it("既存の設定を保ったまま適用でき、適用後に制約と index が働く", async () => {
    const upgradeContainer = await startPostgresContainer();
    try {
      const migrationsDir = path.join(infrastructureRoot, "database", "migrations");
      const names = fs
        .readdirSync(migrationsDir)
        .filter((name) => /^\d{14}_/.test(name))
        .sort();
      expect(names).toContain(T402_MIGRATION);

      const env = { ...process.env, DATABASE_URL: upgradeContainer.getConnectionUri() };
      const staging = fs.mkdtempSync(path.join(infrastructureRoot, ".t402-upgrade-"));
      const stagingConfig = path.join(infrastructureRoot, ".t402-upgrade.config.ts");
      try {
        fs.copyFileSync(
          path.join(migrationsDir, "migration_lock.toml"),
          path.join(staging, "migration_lock.toml"),
        );
        for (const name of names.filter((n) => n < T402_MIGRATION)) {
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

      // T-402 より前の schema に、T-401 の設定行がある状態を作る。
      const client = createPrismaClient(upgradeContainer.getConnectionUri());
      try {
        const user = await client.user.create({
          data: {
            authSubject: "credentials:upgrade@example.com",
            emailNormalized: "upgrade@example.com",
            passwordHash: "hash",
          },
        });
        await client.$executeRaw`
          INSERT INTO notification_settings (user_id, local_time, timezone, enabled)
          VALUES (${user.id}, '08:00'::time, 'Asia/Tokyo', true)`;

        execFileSync(prismaCli, ["migrate", "deploy", "--config", prismaConfigPath], {
          cwd: infrastructureRoot,
          env,
          stdio: "pipe",
        });

        expect(await client.notificationSetting.count({ where: { userId: user.id } })).toBe(1);
        const indexes = await client.$queryRaw<{ indexname: string }[]>`
          SELECT indexname FROM pg_indexes
          WHERE indexname IN ('notification_deliveries_provider_message_id_uidx',
                              'notification_deliveries_pending_next_attempt_idx',
                              'notification_settings_enabled_scan_idx',
                              'email_suppressions_user_id_key')`;
        expect(indexes).toHaveLength(4);
        await expect(
          client.$executeRaw`INSERT INTO email_suppressions (user_id, reason) VALUES (${user.id}, 'bounce')`,
        ).resolves.toBeDefined();
      } finally {
        await client.$disconnect();
      }
    } finally {
      await upgradeContainer.stop();
    }
  }, 180_000);
});
