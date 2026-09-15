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
  UpdateHabitDetailsInput,
} from "./habit";

export {
  HabitDomainError,
  InvalidHabitKindError,
  InvalidHabitDetailsError,
  InvalidScheduleVersionError,
  OverlappingScheduleVersionError,
  UnsupportedScheduleChangeError,
  HabitArchivedError,
} from "./errors";
