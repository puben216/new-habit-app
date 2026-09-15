import { isValidCalendarDate, isBeforeOrEqualCalendarDate } from "./calendar-date";
import { InvalidScheduleVersionError, OverlappingScheduleVersionError } from "./errors";
import type { HabitKind } from "./habit-kind";

/**
 * `habit_schedule_versions` に対応する値オブジェクト。
 *
 * docs/04-database-design.md の CHECK 制約と同じ値域を Domain の純粋関数として
 * 定義する(「これらは Domain の純粋関数を唯一の定義とし、SQL 集計を追加する場合も
 * 同じ契約テストを通す」という設計方針に合わせる)。
 *
 * - daysOfWeek: 0(日)〜6(土)、空でない配列。DB の CHECK 制約は重複を禁止しないが、
 *   Domain では重複を追加の不変条件として拒否する(同じ曜日を二重に持つことに
 *   業務上の意味がなく、T-201 の予定機会生成であいまいさを生むため)。
 * - targetCount: 正の整数。kind が "reduce" の場合は必ず 1
 *   (docs/01-product-requirements.md の業務ルール、
 *   docs/04-database-design.md「実装時の補足(T-004)」)。
 *   04 では「habit.kind を跨ぐ検証のため DB constraint/trigger ではなく
 *   Application 層(T-104)で検証する」とされているが、これは DB 実装上の制約
 *   (trigger で他テーブルを参照する必要がある)についての記述であり、
 *   Domain の Habit 集約は kind と ScheduleVersion を同時に扱えるため、
 *   ここで不変条件として強制する方が DDD 的に自然と判断した(PR の
 *   Decisions 参照)。Application 層は Domain 経由でのみ ScheduleVersion を
 *   生成することで、この不変条件を再実装せず再利用する。
 * - effectiveFrom/effectiveTo: タイムゾーンを持たない暦日(YYYY-MM-DD)。
 *   effectiveTo が null の場合は無期限。
 */
export interface ScheduleVersionInput {
  effectiveFrom: string;
  effectiveTo?: string | null;
  daysOfWeek: readonly number[];
  targetCount: number;
}

export interface ScheduleVersion {
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly daysOfWeek: readonly number[];
  readonly targetCount: number;
}

const MIN_DAY_OF_WEEK = 0;
const MAX_DAY_OF_WEEK = 6;

function assertValidDaysOfWeek(daysOfWeek: readonly number[]): void {
  if (daysOfWeek.length === 0) {
    throw new InvalidScheduleVersionError("daysOfWeek は空にできません。");
  }
  const seen = new Set<number>();
  for (const day of daysOfWeek) {
    if (!Number.isInteger(day) || day < MIN_DAY_OF_WEEK || day > MAX_DAY_OF_WEEK) {
      throw new InvalidScheduleVersionError(
        `daysOfWeek の値は ${MIN_DAY_OF_WEEK}〜${MAX_DAY_OF_WEEK} の整数である必要があります: ${String(day)}`,
      );
    }
    if (seen.has(day)) {
      throw new InvalidScheduleVersionError(`daysOfWeek に重複した曜日があります: ${day}`);
    }
    seen.add(day);
  }
}

function assertValidTargetCount(targetCount: number, kind: HabitKind): void {
  if (!Number.isInteger(targetCount) || targetCount <= 0) {
    throw new InvalidScheduleVersionError(
      `targetCount は正の整数である必要があります: ${String(targetCount)}`,
    );
  }
  if (kind === "reduce" && targetCount !== 1) {
    throw new InvalidScheduleVersionError(
      `reduce の targetCount は 1 固定です(MVP): ${String(targetCount)}`,
    );
  }
}

function assertValidEffectivePeriod(effectiveFrom: string, effectiveTo: string | null): void {
  if (!isValidCalendarDate(effectiveFrom)) {
    throw new InvalidScheduleVersionError(
      `effectiveFrom は有効な暦日ではありません: ${effectiveFrom}`,
    );
  }
  if (effectiveTo !== null) {
    if (!isValidCalendarDate(effectiveTo)) {
      throw new InvalidScheduleVersionError(
        `effectiveTo は有効な暦日ではありません: ${effectiveTo}`,
      );
    }
    if (!isBeforeOrEqualCalendarDate(effectiveFrom, effectiveTo)) {
      throw new InvalidScheduleVersionError(
        `effectiveTo(${effectiveTo}) は effectiveFrom(${effectiveFrom}) 以降である必要があります。`,
      );
    }
  }
}

/**
 * ScheduleVersion を生成する。kind を明示的に受け取ることで、
 * reduce の targetCount=1 固定という habit.kind を跨ぐ不変条件をここで検証する。
 */
export function createScheduleVersion(
  kind: HabitKind,
  input: ScheduleVersionInput,
): ScheduleVersion {
  const effectiveTo = input.effectiveTo ?? null;
  assertValidEffectivePeriod(input.effectiveFrom, effectiveTo);
  assertValidDaysOfWeek(input.daysOfWeek);
  assertValidTargetCount(input.targetCount, kind);

  return Object.freeze({
    effectiveFrom: input.effectiveFrom,
    effectiveTo,
    daysOfWeek: Object.freeze([...input.daysOfWeek].sort((a, b) => a - b)),
    targetCount: input.targetCount,
  });
}

/** 既存の ScheduleVersion の effectiveTo を差し替えた新しい ScheduleVersion を返す。 */
export function closeScheduleVersion(
  version: ScheduleVersion,
  effectiveTo: string,
): ScheduleVersion {
  if (!isValidCalendarDate(effectiveTo)) {
    throw new InvalidScheduleVersionError(`effectiveTo は有効な暦日ではありません: ${effectiveTo}`);
  }
  if (!isBeforeOrEqualCalendarDate(version.effectiveFrom, effectiveTo)) {
    throw new InvalidScheduleVersionError(
      `effectiveTo(${effectiveTo}) は effectiveFrom(${version.effectiveFrom}) 以降である必要があります。`,
    );
  }
  if (
    version.effectiveTo !== null &&
    !isBeforeOrEqualCalendarDate(effectiveTo, version.effectiveTo)
  ) {
    throw new InvalidScheduleVersionError(
      `effectiveTo(${effectiveTo}) は既存の effectiveTo(${version.effectiveTo}) より後にできません。`,
    );
  }
  return Object.freeze({
    ...version,
    effectiveTo,
  });
}

/** 2 つの ScheduleVersion の有効期間([effectiveFrom, effectiveTo])が重なるか判定する。 */
export function scheduleVersionsOverlap(a: ScheduleVersion, b: ScheduleVersion): boolean {
  const aEndsAfterOrOnBStart =
    a.effectiveTo === null || isBeforeOrEqualCalendarDate(b.effectiveFrom, a.effectiveTo);
  const bEndsAfterOrOnAStart =
    b.effectiveTo === null || isBeforeOrEqualCalendarDate(a.effectiveFrom, b.effectiveTo);
  return aEndsAfterOrOnBStart && bEndsAfterOrOnAStart;
}

/**
 * `versions` の中に有効期間が重複するものがあれば OverlappingScheduleVersionError を投げる。
 * docs/04-database-design.md の exclusion constraint(GiST)と同趣旨の検証を、
 * DB へ到達する前に Domain で先に検知する。
 */
export function assertNoOverlappingScheduleVersions(versions: readonly ScheduleVersion[]): void {
  for (let i = 0; i < versions.length; i += 1) {
    for (let j = i + 1; j < versions.length; j += 1) {
      const a = versions[i];
      const b = versions[j];
      if (a !== undefined && b !== undefined && scheduleVersionsOverlap(a, b)) {
        throw new OverlappingScheduleVersionError(
          `ScheduleVersion の有効期間が重複しています: ${a.effectiveFrom}〜${a.effectiveTo ?? "無期限"} と ${b.effectiveFrom}〜${b.effectiveTo ?? "無期限"}`,
        );
      }
    }
  }
}

/**
 * その日の実施回数(quantity)が targetCount 以上かどうかで成功判定する。
 *
 * docs/04-database-design.md「集計定義」: `build の当日成功は quantity >= target_count`。
 * reduce は targetCount=1 に固定されるため式は共通化できるが、reduce の quantity が
 * 「対象行動を回避できた(1)/できなかった(0)」を表すのか「対象行動が発生した回数」を
 * 表すのかは 01/04 に明記がなく、本 PR の Open Question として扱う
 * (HabitEntry 自体は tracking モジュール(T-201/T-202)の管轄であり本 PR の実装範囲外)。
 */
export function isTargetMet(
  scheduleVersion: Pick<ScheduleVersion, "targetCount">,
  quantity: number,
): boolean {
  return quantity >= scheduleVersion.targetCount;
}
