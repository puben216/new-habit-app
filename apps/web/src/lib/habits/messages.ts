import { CLIENT_ERROR_CODES, isApiError } from "@/lib/api/api-error";

import type { FormIssue, HabitFormField } from "./form";

/** 習慣画面の固定文言(HUI-006、WUI-INV-003: server の文字列は描画しない)。 */
export const CONFLICT_MESSAGE =
  "他の場所で更新されました。最新の内容を読み込んでから、もう一度保存してください。";
export const ARCHIVED_MESSAGE = "この習慣はアーカイブ済みのため、変更できません。";
export const NOT_FOUND_MESSAGE = "習慣が見つかりません";
export const NO_CHANGES_MESSAGE = "変更がありません。";
export const NETWORK_MESSAGE = "通信に失敗しました。時間をおいてもう一度お試しください。";
export const UNEXPECTED_MESSAGE =
  "処理を完了できませんでした。時間をおいてもう一度お試しください。";
export const FORM_INVALID_MESSAGE = "入力内容を確認してください。";
export const RETROACTIVE_MESSAGE =
  "適用開始日は、現在のスケジュールの開始日より後の日付にしてください。";

const FIELD_LABEL: Record<HabitFormField, string> = {
  name: "名前",
  purpose: "目的",
  cue: "きっかけ",
  minimumAction: "最小の行動",
  replacementAction: "代わりの行動",
  effectiveFrom: "適用開始日",
  daysOfWeek: "曜日",
  targetCount: "回数",
};

export function fieldLabel(field: HabitFormField): string {
  return FIELD_LABEL[field];
}

/** クライアント検証の結果を固定文言にする。 */
export function issueMessage(field: HabitFormField, issue: FormIssue): string {
  const label = FIELD_LABEL[field];
  if (field === "daysOfWeek") return "曜日を1つ以上選んでください。";
  if (field === "targetCount") return "回数は1〜100の整数で入力してください。";
  if (issue === "required") return `${label}を入力してください。`;
  if (issue === "too_long") {
    return `${label}は${field === "name" ? 100 : 500}文字以内で入力してください。`;
  }
  return `${label}を確認してください。`;
}

export type HabitErrorKind =
  "conflict" | "archived" | "not_found" | "validation" | "network" | "unexpected";

export interface DescribedHabitError {
  readonly kind: HabitErrorKind;
  readonly fields: Partial<Record<HabitFormField, string>>;
  readonly form: string | null;
}

/** server の `fieldErrors` のキー → フォーム項目。未知のキーは対応なし。 */
const SERVER_FIELD_KEYS: Readonly<Record<string, HabitFormField>> = {
  name: "name",
  purpose: "purpose",
  cue: "cue",
  minimumAction: "minimumAction",
  replacementAction: "replacementAction",
  "schedule.effectiveFrom": "effectiveFrom",
  "schedule.daysOfWeek": "daysOfWeek",
  "schedule.targetCount": "targetCount",
  schedule: "daysOfWeek",
};

function serverRejectedMessage(field: HabitFormField): string {
  if (field === "effectiveFrom") return RETROACTIVE_MESSAGE;
  if (field === "daysOfWeek") return "曜日の指定を確認してください。";
  if (field === "targetCount") return "回数の指定を確認してください。";
  return `${FIELD_LABEL[field]}を確認してください。`;
}

/** API 失敗を固定文言と分類へ変換する。使うのは status・code・fieldErrors のキーだけ。 */
export function describeHabitError(error: unknown): DescribedHabitError {
  if (!isApiError(error)) return { kind: "unexpected", fields: {}, form: UNEXPECTED_MESSAGE };
  if (error.code === CLIENT_ERROR_CODES.networkError) {
    return { kind: "network", fields: {}, form: NETWORK_MESSAGE };
  }
  if (error.status === 409 && error.code === "version_conflict") {
    return { kind: "conflict", fields: {}, form: CONFLICT_MESSAGE };
  }
  if (error.status === 409 && error.code === "habit_archived") {
    return { kind: "archived", fields: {}, form: ARCHIVED_MESSAGE };
  }
  // 不正な ID(path として許可されない値)も、存在しない習慣と同じ扱いにする。
  if (error.code === CLIENT_ERROR_CODES.invalidRequestPath) {
    return { kind: "not_found", fields: {}, form: NOT_FOUND_MESSAGE };
  }
  if (error.status === 404) return { kind: "not_found", fields: {}, form: NOT_FOUND_MESSAGE };
  if (error.status === 422) {
    const fields: Partial<Record<HabitFormField, string>> = {};
    for (const key of Object.keys(error.fieldErrors ?? {})) {
      const field = SERVER_FIELD_KEYS[key];
      if (field !== undefined) fields[field] = serverRejectedMessage(field);
    }
    return {
      kind: "validation",
      fields,
      form: Object.keys(fields).length > 0 ? null : FORM_INVALID_MESSAGE,
    };
  }
  return { kind: "unexpected", fields: {}, form: UNEXPECTED_MESSAGE };
}
