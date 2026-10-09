variable "region" {
  description = "AWS リージョン(ADR-005: ap-northeast-1 が第一候補)。"
  type        = string
  default     = "ap-northeast-1"
}

variable "domain" {
  description = "SES の送信ドメイン。ドメイン確定前(ADR-005 follow-up)は dev の検証用ドメインを渡す。"
  type        = string
}

variable "email_from" {
  description = "送信元アドレス(domain に属すること)。"
  type        = string
}

variable "app_base_url" {
  description = "アプリの基点 URL(メール本文のリンクと配信停止 URL に使う)。"
  type        = string
}

variable "lambda_s3_bucket" {
  description = "Lambda の成果物を置いた S3 バケット。"
  type        = string
}

variable "lambda_s3_key" {
  description = "Lambda の成果物の S3 キー。"
  type        = string
}

variable "database_secret_arn" {
  description = "DB 接続文字列の Secrets Manager secret ARN(共通基盤 T-501)。"
  type        = string
}

variable "subnet_ids" {
  description = "Lambda を接続する private subnet(共通基盤 T-501)。"
  type        = list(string)
  default     = []
}

variable "security_group_ids" {
  description = "Lambda に付ける security group(共通基盤 T-501)。"
  type        = list(string)
  default     = []
}

variable "delivery_enabled" {
  description = "通知配送の Feature Flag。実送信の前に sandbox の verified address で検証してから true にする。"
  type        = bool
  default     = false
}

variable "schedule_enabled" {
  description = "5 分間隔のスケジューラを有効にするか。"
  type        = bool
  default     = false
}
