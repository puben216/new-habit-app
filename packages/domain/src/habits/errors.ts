/**
 * habits モジュールの Domain 不変条件違反を表すエラー階層。
 *
 * Application 層(T-104)はこれらを catch し、HTTP/ユースケース固有のエラー型へ
 * 変換する想定。Domain 自身は HTTP ステータス等を持たない。
 */
export class HabitDomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** HabitKind が "build" | "reduce" のいずれでもない場合。 */
export class InvalidHabitKindError extends HabitDomainError {}

/** Habit の基本項目(name/purpose/cue/minimumAction 等)が不変条件を満たさない場合。 */
export class InvalidHabitDetailsError extends HabitDomainError {}

/** ScheduleVersion 単体の値(daysOfWeek/targetCount/有効期間)が不変条件を満たさない場合。 */
export class InvalidScheduleVersionError extends HabitDomainError {}

/** 同一 Habit 内で ScheduleVersion の有効期間が重複する場合。 */
export class OverlappingScheduleVersionError extends HabitDomainError {}

/**
 * Domain が意図的にサポートしない ScheduleVersion 編集(過去版への遡及編集等)が
 * 要求された場合。詳細は habit.ts の changeSchedule のコメントを参照。
 */
export class UnsupportedScheduleChangeError extends HabitDomainError {}

/** 既にアーカイブ済みの Habit に対して許可されない操作を行おうとした場合。 */
export class HabitArchivedError extends HabitDomainError {}
