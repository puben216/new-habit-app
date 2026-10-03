import { addCalendarDays, isValidCalendarDate, resolveDailyCheckIn } from "@habit-app/domain";

import type { Clock } from "../auth";
import type { ProfileRepositoryPort } from "../identity/ports";
import type { DailyCheckInRecord, DailyCheckInRepositoryPort } from "./check-in-ports";
import { CheckInDateOutOfRangeError, DailyCheckInNotFoundError, UserNotFoundError } from "./errors";
import { resolveLocalToday } from "./local-today";

/**
 * デイリーチェックインの use case(docs/specs/daily-check-in.md)。
 * 内容の検証は Domain の `resolveDailyCheckIn` だけが行い、ここでは再実装しない。
 */

/** 今日から遡ってチェックインできる日数(DCI-INV-005。この定数が唯一の定義)。 */
export const CHECK_IN_BACKDATE_LIMIT_DAYS = 7;

export interface GetDailyCheckInDeps {
  readonly checkInRepository: DailyCheckInRepositoryPort;
}

export interface GetDailyCheckInInput {
  readonly actorUserId: string;
  readonly date: string;
}

/** 自分のその日のチェックインを返す(DCI-004)。対象日の範囲制限はない。 */
export async function getDailyCheckInUseCase(
  deps: GetDailyCheckInDeps,
  input: GetDailyCheckInInput,
): Promise<DailyCheckInRecord> {
  const record = await deps.checkInRepository.find({
    actorUserId: input.actorUserId,
    date: input.date,
  });
  if (record === null) throw new DailyCheckInNotFoundError();
  return record;
}

export interface UpsertDailyCheckInDeps {
  readonly checkInRepository: DailyCheckInRepositoryPort;
  readonly profileRepository: ProfileRepositoryPort;
  readonly now: Clock;
}

export interface UpsertDailyCheckInInput {
  readonly actorUserId: string;
  readonly date: string;
  readonly mood?: number | null | undefined;
  readonly difficulty?: number | null | undefined;
  readonly note?: string | null | undefined;
}

/**
 * チェックインを冪等に作成・訂正(全項目置換)する(DCI-001〜003)。
 *
 * @throws {UserNotFoundError} actor の user が存在しない
 * @throws {CheckInDateOutOfRangeError} 対象日が今日から過去 7 日の範囲外
 * @throws {InvalidDailyCheckInError} 内容が不正(全項目が未設定を含む)
 */
export async function upsertDailyCheckInUseCase(
  deps: UpsertDailyCheckInDeps,
  input: UpsertDailyCheckInInput,
): Promise<DailyCheckInRecord> {
  const today = await resolveLocalToday(deps.profileRepository, deps.now, input.actorUserId);
  if (today === null) throw new UserNotFoundError();

  const oldest = addCalendarDays(today.date, -CHECK_IN_BACKDATE_LIMIT_DAYS);
  if (!isValidCalendarDate(input.date) || input.date < oldest || input.date > today.date) {
    throw new CheckInDateOutOfRangeError();
  }

  const resolved = resolveDailyCheckIn({
    mood: input.mood,
    difficulty: input.difficulty,
    note: input.note,
  });

  const saved = await deps.checkInRepository.upsert({
    actorUserId: input.actorUserId,
    date: input.date,
    mood: resolved.mood,
    difficulty: resolved.difficulty,
    note: resolved.note,
    now: deps.now(),
  });
  if (saved === null) throw new UserNotFoundError();
  return saved;
}
