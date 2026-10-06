import { z } from "zod";

/**
 * `GET /api/v1/dashboard` の契約(docs/specs/statistics-dashboard.md API and Events 節)。
 * runtime schema を正本とし、型は z.infer で導出する(ADR-009)。
 * 集計の定義は Domain(`calculateHabitStatistics`)が持つ。ここでは形と値域のみを表す。
 */
const calendarDateSchema = z.iso.date();
const countSchema = z.number().int().min(0);

export const windowStatisticsSchema = z.object({
  from: calendarDateSchema,
  to: calendarDateSchema,
  scheduled: countSchema,
  success: countSchema,
  missed: countSchema,
  skipped: countSchema,
  pending: countSchema,
  /** `success / (success + missed)`(0〜1)。分母 0 は null。 */
  successRate: z.number().min(0).max(1).nullable(),
});
export type WindowStatisticsResponse = z.infer<typeof windowStatisticsSchema>;

export const dashboardResponseSchema = z.object({
  date: calendarDateSchema,
  timezone: z.string(),
  overall: z.object({
    last7Days: windowStatisticsSchema,
    last30Days: windowStatisticsSchema,
  }),
  habits: z.array(
    z.object({
      habit: z.object({
        id: z.uuid(),
        kind: z.enum(["build", "reduce"]),
        name: z.string(),
      }),
      currentStreak: countSchema,
      longestStreak: countSchema,
      last7Days: windowStatisticsSchema,
      last30Days: windowStatisticsSchema,
    }),
  ),
});
export type DashboardResponse = z.infer<typeof dashboardResponseSchema>;
