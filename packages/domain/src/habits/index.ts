export { HABIT_KINDS, isHabitKind, assertHabitKind } from "./habit-kind";
export type { HabitKind } from "./habit-kind";

export {
  createScheduleVersion,
  closeScheduleVersion,
  scheduleVersionsOverlap,
  assertNoOverlappingScheduleVersions,
  isTargetMet,
} from "./schedule-version";
export type { ScheduleVersion, ScheduleVersionInput } from "./schedule-version";

export {
  createHabit,
  reconstituteHabit,
  updateHabitDetails,
  archiveHabit,
  changeSchedule,
  findScheduleVersionForDate,
} from "./habit";
export type {
  Habit,
  HabitStatus,
  HabitDetailsInput,
  CreateHabitInput,
  ReconstituteHabitInput,
  UpdateHabitDetailsInput,
} from "./habit";

export { addCalendarDays, dayOfWeekOf } from "./calendar-date";
export { localDateAt } from "./local-date";
export {
  MAX_OCCURRENCE_RANGE_DAYS,
  resolveScheduleForDate,
  scheduledOccurrenceOn,
  generateOccurrences,
} from "./occurrence";
export type { ScheduledOccurrence, OccurrenceRange } from "./occurrence";
export { weekStartOf } from "./week";

export {
  HabitDomainError,
  InvalidScheduleCalculationInputError,
  InvalidHabitKindError,
  InvalidHabitDetailsError,
  InvalidScheduleVersionError,
  OverlappingScheduleVersionError,
  UnsupportedScheduleChangeError,
  HabitArchivedError,
} from "./errors";
