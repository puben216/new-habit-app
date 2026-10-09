export type { NotificationSettingsRecord, NotificationSettingsRepositoryPort } from "./ports";
export { NotificationApplicationError, NotificationUserNotFoundError } from "./errors";
export { getNotificationSettingsUseCase, upsertNotificationSettingsUseCase } from "./use-cases";
export type {
  GetNotificationSettingsDeps,
  GetNotificationSettingsInput,
  NotificationSettingsView,
  UpsertNotificationSettingsDeps,
  UpsertNotificationSettingsInput,
} from "./use-cases";

export type {
  EmailSuppressionPort,
  FinalReminderStatus,
  RecipientPort,
  ReminderDeliveryRecord,
  ReminderDeliveryRepositoryPort,
  ReminderEmail,
  ReminderEmailErrorKind,
  ReminderEmailPort,
  ReminderQueuePort,
  ReminderRecipient,
  ReminderScanSetting,
  UnsubscribeTokenPort,
} from "./delivery-ports";
export { ReminderEmailError } from "./delivery-ports";
export { buildReminderEmail } from "./reminder-email";
export type { BuildReminderEmailInput } from "./reminder-email";
export { scheduleDueRemindersUseCase } from "./schedule-due-reminders";
export type {
  ScheduleDueRemindersDeps,
  ScheduleDueRemindersSummary,
} from "./schedule-due-reminders";
export { UNSUBSCRIBE_PATH, deliverReminderUseCase } from "./deliver-reminder";
export type { DeliverReminderDeps, DeliverReminderOutcome } from "./deliver-reminder";
export { handleEmailFeedbackUseCase } from "./email-feedback";
export type {
  EmailFeedbackEvent,
  HandleEmailFeedbackDeps,
  HandleEmailFeedbackOutcome,
} from "./email-feedback";
export { unsubscribeUseCase } from "./unsubscribe";
export type { UnsubscribeDeps, UnsubscribeOutcome } from "./unsubscribe";
