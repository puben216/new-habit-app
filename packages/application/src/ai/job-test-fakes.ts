import type {
  AiJobAttemptRecord,
  AiJobQueuePort,
  AiJobRecord,
  AiJobRepositoryPort,
} from "./job-ports";

/**
 * AI job use case の Unit Test 専用 fake。永続化・transaction は持たず、use case のロジックと
 * 状態遷移の規則(claim・lease・終端不変)を再現する。
 */
export interface FakeAiJobRepository extends AiJobRepositoryPort {
  readonly calls: readonly { readonly method: string; readonly actorUserId?: string }[];
  readonly jobs: ReadonlyMap<string, AiJobRecord>;
  readonly attempts: readonly { readonly jobId: string; readonly attempt: AiJobAttemptRecord }[];
  /** テスト用: job を直接投入する。`leaseStartedAt` は running の lease 開始時刻。 */
  seed(job: AiJobRecord, leaseStartedAt?: Date): void;
  /** テスト用: 指定したメソッドを次の `times` 回、例外にする。 */
  failNext(method: "claim" | "complete" | "release" | "createOrGet", times?: number): void;
}

export function createFakeAiJobRepository(
  existingUserIds: readonly string[],
  now: () => Date,
): FakeAiJobRepository {
  const users = new Set(existingUserIds);
  const store = new Map<string, AiJobRecord>();
  const leases = new Map<string, Date>();
  const fingerprints = new Map<string, string>();
  const calls: { method: string; actorUserId?: string }[] = [];
  const attempts: { jobId: string; attempt: AiJobAttemptRecord }[] = [];
  const faults = new Map<string, number>();
  let sequence = 0;

  const maybeFail = (method: string): void => {
    const remaining = faults.get(method) ?? 0;
    if (remaining > 0) {
      faults.set(method, remaining - 1);
      throw new Error(`injected failure: ${method}`);
    }
  };
  const update = (job: AiJobRecord, changes: Partial<AiJobRecord>): AiJobRecord => {
    const next = { ...job, ...changes, updatedAt: now() };
    store.set(job.id, next);
    return next;
  };

  return {
    calls,
    jobs: store,
    attempts,
    seed(job, leaseStartedAt) {
      store.set(job.id, job);
      if (leaseStartedAt !== undefined) leases.set(job.id, leaseStartedAt);
    },
    failNext(method, times = 1) {
      faults.set(method, times);
    },
    async findByInput({ actorUserId, kind, subjectId, promptVersion, inputFingerprint }) {
      calls.push({ method: "findByInput", actorUserId });
      const found = [...store.values()].find(
        (job) =>
          job.userId === actorUserId &&
          job.kind === kind &&
          job.subjectId === subjectId &&
          job.promptVersion === promptVersion &&
          fingerprints.get(job.id) === inputFingerprint,
      );
      return found ?? null;
    },
    async countActive({ actorUserId }) {
      calls.push({ method: "countActive", actorUserId });
      return [...store.values()].filter(
        (job) =>
          job.userId === actorUserId && (job.status === "queued" || job.status === "running"),
      ).length;
    },
    async createOrGet(input) {
      calls.push({ method: "createOrGet", actorUserId: input.actorUserId });
      maybeFail("createOrGet");
      if (!users.has(input.actorUserId)) return null;
      const existing = [...store.values()].find(
        (job) =>
          job.userId === input.actorUserId &&
          job.kind === input.kind &&
          job.subjectId === input.subjectId &&
          job.promptVersion === input.promptVersion &&
          fingerprints.get(job.id) === input.inputFingerprint,
      );
      if (existing !== undefined) return { job: existing, created: false };
      sequence += 1;
      const job: AiJobRecord = {
        id: `20000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
        userId: input.actorUserId,
        kind: input.kind,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        status: "queued",
        promptVersion: input.promptVersion,
        outputSchemaVersion: input.outputSchemaVersion,
        provider: input.provider,
        model: input.model,
        result: null,
        failureCode: null,
        createdAt: input.now,
        updatedAt: input.now,
      };
      store.set(job.id, job);
      fingerprints.set(job.id, input.inputFingerprint);
      return { job, created: true };
    },
    async findById({ actorUserId, jobId }) {
      calls.push({ method: "findById", actorUserId });
      const job = store.get(jobId);
      return job !== undefined && job.userId === actorUserId ? job : null;
    },
    async claim({ jobId, leaseSeconds }) {
      calls.push({ method: "claim" });
      maybeFail("claim");
      const job = store.get(jobId);
      if (job === undefined) return { status: "not_found" };
      switch (job.status) {
        case "succeeded":
        case "failed":
        case "fallback":
          return { status: "finished" };
        case "running": {
          const started = leases.get(jobId) ?? new Date(0);
          if (now().getTime() - started.getTime() <= leaseSeconds * 1000) {
            return { status: "in_progress" };
          }
          break;
        }
        case "queued":
          break;
      }
      leases.set(jobId, now());
      return { status: "claimed", job: update(job, { status: "running" }) };
    },
    async complete(input) {
      calls.push({ method: "complete" });
      maybeFail("complete");
      const job = store.get(input.jobId);
      if (job === undefined || job.status !== "running") return "lost";
      attempts.push({ jobId: input.jobId, attempt: input.attempt });
      if (input.status === "failed") {
        update(job, { status: "failed", failureCode: input.failureCode });
      } else {
        update(job, { status: input.status, result: input.result, model: input.model });
      }
      return "completed";
    },
    async release({ jobId, attempt }) {
      calls.push({ method: "release" });
      maybeFail("release");
      const job = store.get(jobId);
      if (job === undefined || job.status !== "running") return;
      attempts.push({ jobId, attempt });
      update(job, { status: "queued" });
    },
  };
}

export interface FakeAiJobQueue extends AiJobQueuePort {
  readonly messages: readonly { readonly v: 1; readonly jobId: string }[];
  /** テスト用: 次の `enqueue` を失敗させる。 */
  failNext(times?: number): void;
}

export function createFakeAiJobQueue(): FakeAiJobQueue {
  const messages: { v: 1; jobId: string }[] = [];
  let failures = 0;
  return {
    messages,
    failNext(times = 1) {
      failures = times;
    },
    async enqueue(message) {
      if (failures > 0) {
        failures -= 1;
        throw new Error("injected queue failure");
      }
      messages.push({ v: message.v, jobId: message.jobId });
    },
  };
}
