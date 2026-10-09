variable "name_prefix" {
  description = "リソース名の接頭辞(例: habit-app-dev)。"
  type        = string
}

variable "domain" {
  description = "SES の送信ドメイン(例: example.com)。ドメイン確定前は dev の検証用ドメインを渡す(ADR-005 follow-up)。"
  type        = string
}

variable "manage_account_suppression" {
  description = "SES の account-level suppression list(BOUNCE/COMPLAINT)をこのモジュールで管理するか。リージョン内のアカウント全体の設定のため、1 つの環境でのみ true にする。"
  type        = bool
  default     = false
}
