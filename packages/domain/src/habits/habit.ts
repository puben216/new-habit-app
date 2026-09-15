import { previousCalendarDate, isBeforeCalendarDate } from "./calendar-date";
import {
  HabitArchivedError,
  InvalidHabitDetailsError,
  UnsupportedScheduleChangeError,
} from "./errors";
import { assertHabitKind } from "./habit-kind";
import type { HabitKind } from "./habit-kind";
import {
  assertNoOverlappingScheduleVersions,
  closeScheduleVersion,
  createScheduleVersion,
} from "./schedule-version";
import type { ScheduleVersion, ScheduleVersionInput } from "./schedule-version";

/**
 * `habits` テーブルに対応する Habit 集約。
 *
 * Domain の責務(docs/03-architecture.md)に限定し、以下は意図的に含めない。
 * - 永続化・repository・トランザクション(Application/Infrastructure, T-104)
 * - id/publicId の生成方式(UUID採番等はApplication/Infrastructureの責務)
 * - 楽観ロック用の `version` 列(Prisma/Application層の関心事)
 * - HabitEntry(実施記録)そのもの。isTargetMet 等の純粋な成功判定関数のみを
 *   schedule-version.ts に用意し、記録の永続化・集計は tracking モジュール
 *   (T-201/T-202)の管轄とする。
 */
export type HabitStatus = "active" | "archived";

export interface HabitDetailsInput {
  name: string;
  purpose: string;
  cue: string;
  minimumAction: string;
  /** reduce では推奨だが必須ではない(docs/04-database-design.md)。 */
  replacementAction?: string | null;
}

export interface CreateHabitInput extends HabitDetailsInput {
  /** Application/Infrastructure が採番した識別子をそのまま受け取る(Domain は生成しない)。 */
  id: string;
  kind: HabitKind;
  initialSchedule: ScheduleVersionInput;
}

export interface Habit {
  readonly id: string;
  readonly kind: HabitKind;
  readonly name: string;
  readonly purpose: string;
  readonly cue: string;
  readonly minimumAction: string;
  readonly replacementAction: string | null;
  readonly status: HabitStatus;
  readonly scheduleVersions: readonly ScheduleVersion[];
}

/**
 * kind の変更を受け付けない更新用入力。TypeScript の型として kind フィールド自体を
 * 持たないため、コンパイル時に「kind は更新できない」ことを強制する
 * (docs/01-product-requirements.md「種類変更は...作成後変更不可」)。
 * 加えて Habit オブジェクト自体を Object.freeze することで、実行時の
 * 直接プロパティ代入(`habit.kind = ...` 等)も TypeError として防ぐ。
 */
export type UpdateHabitDetailsInput = Partial<HabitDetailsInput>;

function assertNonEmpty(fieldName: string, value: string): void {
  if (value.trim().length === 0) {
    throw new InvalidHabitDetailsError(`${fieldName} を空にはできません。`);
  }
}

function assertValidId(id: string): void {
  if (id.trim().length === 0) {
    throw new InvalidHabitDetailsError("id を空にはできません。");
  }
}

/**
 * 文字数上限は docs/10-decisions-and-open-questions.md の P2 で未決のため、
 * Domain では意図的に課さない(空文字のみを拒否する)。上限が決まり次第、
 * ここへ追加する。
 */
function assertValidDetails(details: HabitDetailsInput): void {
  assertNonEmpty("name", details.name);
  assertNonEmpty("purpose", details.purpose);
  assertNonEmpty("cue", details.cue);
  assertNonEmpty("minimumAction", details.minimumAction);
  if (details.replacementAction != null) {
    assertNonEmpty("replacementAction", details.replacementAction);
  }
}

function normalizeDetails(
  details: HabitDetailsInput,
): HabitDetailsInput & { replacementAction: string | null } {
  return {
    name: details.name.trim(),
    purpose: details.purpose.trim(),
    cue: details.cue.trim(),
    minimumAction: details.minimumAction.trim(),
    replacementAction: details.replacementAction != null ? details.replacementAction.trim() : null,
  };
}

export function createHabit(input: CreateHabitInput): Habit {
  assertValidId(input.id);
  assertHabitKind(input.kind);
  assertValidDetails(input);
  const normalized = normalizeDetails(input);
  const initialVersion = createScheduleVersion(input.kind, input.initialSchedule);

  return Object.freeze({
    id: input.id,
    kind: input.kind,
    ...normalized,
    status: "active" as const,
    scheduleVersions: Object.freeze([initialVersion]),
  });
}

function assertNotArchived(habit: Habit): void {
  if (habit.status === "archived") {
    throw new HabitArchivedError(`Habit(${habit.id}) は既にアーカイブ済みです。`);
  }
}

/** name/purpose/cue/minimumAction/replacementAction を更新する。kind は更新できない。 */
export function updateHabitDetails(habit: Habit, changes: UpdateHabitDetailsInput): Habit {
  assertNotArchived(habit);
  const merged: HabitDetailsInput = {
    name: changes.name ?? habit.name,
    purpose: changes.purpose ?? habit.purpose,
    cue: changes.cue ?? habit.cue,
    minimumAction: changes.minimumAction ?? habit.minimumAction,
    replacementAction:
      changes.replacementAction !== undefined ? changes.replacementAction : habit.replacementAction,
  };
  assertValidDetails(merged);
  const normalized = normalizeDetails(merged);

  return Object.freeze({
    ...habit,
    ...normalized,
  });
}

export function archiveHabit(habit: Habit): Habit {
  if (habit.status === "archived") {
    return habit;
  }
  return Object.freeze({ ...habit, status: "archived" as const });
}

/**
 * スケジュールを変更する。
 *
 * docs/01-product-requirements.md「習慣の編集は過去集計を書き換えないよう、
 * スケジュール変更の有効開始日を保持する」を実現するため、既存の
 * ScheduleVersion を書き換えるのではなく、
 *   1. 新しい有効期間と重なる既存の版があれば、その版の effectiveFrom は
 *      変更せず、effectiveTo だけを新しい版の前日に設定して「閉じる」
 *   2. 新しい ScheduleVersion を追加する
 * という追加専用(append-only)の操作として扱う。
 *
 * サポートするのは「既存のどの版の effectiveFrom よりも後の日付から新しい版を
 * 開始する」という追記(append)のみ。意図的にサポートしない範囲
 * (Domain を最小限に保つための判断):
 * - 新しい effectiveFrom が既存のいずれかの版の effectiveFrom 以前になる編集
 *   (過去の版を分割・削除する必要があり、どの過去記録の解釈を変えてよいかは
 *   業務判断が必要なため)。この場合は UnsupportedScheduleChangeError を投げる。
 * - 1 度の呼び出しで複数の ScheduleVersion をまとめて追加/削除すること。
 * - 「今日より前には遡れない」といった Clock 依存のポリシー判定。Domain は
 *   Clock を持たないため、日付が過去か未来かは判定できない。この種の
 *   ポリシーは Application 層(T-104)が Clock を注入して判断する想定。
 * これらが必要になった場合は T-104 で Application 層のユースケースとして
 * 個別に設計する。
 */
export function changeSchedule(habit: Habit, input: ScheduleVersionInput): Habit {
  assertNotArchived(habit);
  const newVersion = createScheduleVersion(habit.kind, input);

  for (const version of habit.scheduleVersions) {
    if (!isBeforeCalendarDate(version.effectiveFrom, newVersion.effectiveFrom)) {
      throw new UnsupportedScheduleChangeError(
        `既存の ScheduleVersion(effectiveFrom=${version.effectiveFrom}) 以前を新しい effectiveFrom(${newVersion.effectiveFrom})に指定する遡及編集はサポートしません。`,
      );
    }
  }

  const adjustedExisting: ScheduleVersion[] = habit.scheduleVersions.map((version) => {
    const needsClosing =
      version.effectiveTo === null ||
      !isBeforeCalendarDate(version.effectiveTo, newVersion.effectiveFrom);
    return needsClosing
      ? closeScheduleVersion(version, previousCalendarDate(newVersion.effectiveFrom))
      : version;
  });

  const allVersions = [...adjustedExisting, newVersion];
  assertNoOverlappingScheduleVersions(allVersions);

  return Object.freeze({
    ...habit,
    scheduleVersions: Object.freeze(allVersions),
  });
}

/** habit.status === "active" かつ与えた暦日を含む ScheduleVersion を探す。 */
export function findScheduleVersionForDate(
  habit: Habit,
  calendarDate: string,
): ScheduleVersion | null {
  for (const version of habit.scheduleVersions) {
    const afterStart = !isBeforeCalendarDate(calendarDate, version.effectiveFrom);
    const beforeEnd =
      version.effectiveTo === null || !isBeforeCalendarDate(version.effectiveTo, calendarDate);
    if (afterStart && beforeEnd) {
      return version;
    }
  }
  return null;
}
