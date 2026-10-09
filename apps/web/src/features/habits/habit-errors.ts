import type { ErrorSummaryItem } from "@/components/error-summary";
import type { HabitFormField } from "@/lib/habits/form";

const FIELD_ORDER: readonly HabitFormField[] = [
  "name",
  "purpose",
  "cue",
  "minimumAction",
  "replacementAction",
  "effectiveFrom",
  "daysOfWeek",
  "targetCount",
];

/** 項目ごとのエラーとフォーム全体のエラーを、画面上の並び順のエラー要約にする。 */
export function summaryItems(
  errors: Partial<Record<HabitFormField, string>>,
  formError: string | null,
): ErrorSummaryItem[] {
  return [
    ...FIELD_ORDER.flatMap((field) => {
      const message = errors[field];
      return message === undefined ? [] : [{ fieldId: field, message }];
    }),
    ...(formError === null ? [] : [{ message: formError }]),
  ];
}
