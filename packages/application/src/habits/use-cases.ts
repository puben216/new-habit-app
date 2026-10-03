import {
  archiveHabit as archiveDomainHabit,
  changeSchedule,
  createHabit as createDomainHabit,
  updateHabitDetails,
} from "@habit-app/domain";
import type { HabitKind, ScheduleVersionInput, UpdateHabitDetailsInput } from "@habit-app/domain";

import type { Clock } from "../auth";
import { decodeHabitCursor, encodeHabitCursor } from "./cursor";
import { HabitNotFoundError, HabitVersionConflictError, InvalidCursorError } from "./errors";
import type {
  HabitListStatus,
  HabitRecord,
  HabitRepositoryPort,
  IdGeneratorPort,
  SaveHabitResult,
} from "./ports";

/**
 * 習慣の use case(docs/specs/habit-api.md)。
 * 業務ルールの検証は Domain の関数だけが行い、ここでは再実装しない。
 * Domain の不変条件違反(HabitDomainError 階層)はそのまま伝播させる。
 * 認可は、すべての repository 呼び出しに actorUserId を渡すことで行う(HAPI-INV-001)。
 */

/** 保存結果を HabitRecord へ変換し、競合/不存在を Application error に写す。 */
function unwrapSaveResult(result: SaveHabitResult): HabitRecord {
  switch (result.status) {
    case "saved":
      return result.record;
    case "conflict":
      throw new HabitVersionConflictError();
    case "not_found":
      throw new HabitNotFoundError();
    default: {
      const exhaustive: never = result;
      return exhaustive;
    }
  }
}

export interface CreateHabitDeps {
  readonly habitRepository: HabitRepositoryPort;
  readonly idGenerator: IdGeneratorPort;
  readonly now: Clock;
}

export interface CreateHabitUseCaseInput {
  readonly actorUserId: string;
  readonly kind: HabitKind;
  readonly name: string;
  readonly purpose: string;
  readonly cue: string;
  readonly minimumAction: string;
  readonly replacementAction?: string | null;
  readonly schedule: ScheduleVersionInput;
}

export async function createHabitUseCase(
  deps: CreateHabitDeps,
  input: CreateHabitUseCaseInput,
): Promise<HabitRecord> {
  const habit = createDomainHabit({
    id: deps.idGenerator.generate(),
    kind: input.kind,
    name: input.name,
    purpose: input.purpose,
    cue: input.cue,
    minimumAction: input.minimumAction,
    ...(input.replacementAction !== undefined
      ? { replacementAction: input.replacementAction }
      : {}),
    initialSchedule: input.schedule,
  });
  return deps.habitRepository.create({
    actorUserId: input.actorUserId,
    habit,
    now: deps.now(),
  });
}

export interface GetHabitDeps {
  readonly habitRepository: HabitRepositoryPort;
}

export interface GetHabitInput {
  readonly actorUserId: string;
  readonly habitId: string;
}

export async function getHabitUseCase(
  deps: GetHabitDeps,
  input: GetHabitInput,
): Promise<HabitRecord> {
  const record = await deps.habitRepository.findById({
    actorUserId: input.actorUserId,
    habitId: input.habitId,
  });
  if (record === null) throw new HabitNotFoundError();
  return record;
}

export interface ListHabitsDeps {
  readonly habitRepository: HabitRepositoryPort;
}

export interface ListHabitsInput {
  readonly actorUserId: string;
  readonly status: HabitListStatus;
  readonly limit: number;
  readonly cursor?: string | undefined;
}

export interface ListHabitsResult {
  readonly items: readonly HabitRecord[];
  readonly nextCursor: string | null;
}

export async function listHabitsUseCase(
  deps: ListHabitsDeps,
  input: ListHabitsInput,
): Promise<ListHabitsResult> {
  const afterHabitId =
    input.cursor === undefined ? null : decodeHabitCursor(input.cursor, input.status).habitId;

  // 次ページの有無を判定するため 1 件多く取得する。
  const result = await deps.habitRepository.list({
    actorUserId: input.actorUserId,
    status: input.status,
    limit: input.limit + 1,
    afterHabitId,
  });
  if (!result.ok) throw new InvalidCursorError();

  const hasMore = result.items.length > input.limit;
  const items = hasMore ? result.items.slice(0, input.limit) : result.items;
  const last = items[items.length - 1];
  const nextCursor =
    hasMore && last !== undefined
      ? encodeHabitCursor({ habitId: last.habit.id, status: input.status })
      : null;
  return { items, nextCursor };
}

export interface UpdateHabitDeps {
  readonly habitRepository: HabitRepositoryPort;
  readonly now: Clock;
}

export interface UpdateHabitUseCaseInput {
  readonly actorUserId: string;
  readonly habitId: string;
  /** クライアントが最後に取得した version。 */
  readonly version: number;
  readonly details?: UpdateHabitDetailsInput | undefined;
  readonly schedule?: ScheduleVersionInput | undefined;
}

export async function updateHabitUseCase(
  deps: UpdateHabitDeps,
  input: UpdateHabitUseCaseInput,
): Promise<HabitRecord> {
  const current = await deps.habitRepository.findById({
    actorUserId: input.actorUserId,
    habitId: input.habitId,
  });
  if (current === null) throw new HabitNotFoundError();
  if (current.version !== input.version) throw new HabitVersionConflictError();

  if (input.details === undefined && input.schedule === undefined) return current;

  let habit = current.habit;
  if (input.details !== undefined) habit = updateHabitDetails(habit, input.details);
  if (input.schedule !== undefined) habit = changeSchedule(habit, input.schedule);

  return unwrapSaveResult(
    await deps.habitRepository.save({
      actorUserId: input.actorUserId,
      habit,
      expectedVersion: input.version,
      now: deps.now(),
    }),
  );
}

export interface ArchiveHabitDeps {
  readonly habitRepository: HabitRepositoryPort;
  readonly now: Clock;
}

export interface ArchiveHabitUseCaseInput {
  readonly actorUserId: string;
  readonly habitId: string;
  readonly version: number;
}

/**
 * アーカイブ。既に archived の場合は version を検査せず現状を返す(冪等。クライアントの再送が
 * 409 にならないようにするため。docs/specs/habit-api.md HAPI-005)。
 */
export async function archiveHabitUseCase(
  deps: ArchiveHabitDeps,
  input: ArchiveHabitUseCaseInput,
): Promise<HabitRecord> {
  const current = await deps.habitRepository.findById({
    actorUserId: input.actorUserId,
    habitId: input.habitId,
  });
  if (current === null) throw new HabitNotFoundError();
  if (current.habit.status === "archived") return current;
  if (current.version !== input.version) throw new HabitVersionConflictError();

  return unwrapSaveResult(
    await deps.habitRepository.save({
      actorUserId: input.actorUserId,
      habit: archiveDomainHabit(current.habit),
      expectedVersion: input.version,
      now: deps.now(),
    }),
  );
}
