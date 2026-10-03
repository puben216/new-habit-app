import { HabitDomainError } from "../habits/errors";

/** 記録の status/quantity が、習慣の kind と目標回数に対して不整合な場合(docs/specs/habit-entry.md HENT-003)。 */
export class InvalidHabitEntryError extends HabitDomainError {
  /** 問題のある入力項目。Presentation が fieldErrors の項目名に使う。 */
  readonly field: "status" | "quantity";

  constructor(field: "status" | "quantity", message: string) {
    super(message);
    this.field = field;
  }
}
