variable "name_prefix" {
  description = "リソース名の接頭辞(例: habit-app-dev)。"
  type        = string
}

variable "lambda_s3_bucket" {
  description = "Lambda の成果物(zip)を置いた S3 バケット。成果物のビルドと昇格はデプロイ pipeline(T-503)が担う。"
  type        = string
}

variable "lambda_s3_key" {
  description = "Lambda の成果物の S3 キー。zip の直下に handlers/reminder-scheduler.js などを含む。"
  type        = string
}

variable "lambda_runtime" {
  description = "Lambda のランタイム。"
  type        = string
  default     = "nodejs22.x"
}

variable "delivery_enabled" {
  description = "通知配送の Feature Flag(NOTIFICATION_DELIVERY_ENABLED)。false の間は scheduler と delivery は何もしない。"
  type        = bool
  default     = false
}

variable "schedule_enabled" {
  description = "EventBridge Scheduler(5 分間隔)を有効にするか。false にすると新しい配送が作られなくなる(停止手段)。"
  type        = bool
  default     = false
}

variable "app_base_url" {
  description = "アプリの基点 URL(メール本文のリンクと配信停止 URL に使う)。"
  type        = string
}

variable "email_from" {
  description = "送信元アドレス(SES identity のドメインに属すること)。ses:FromAddress 条件の値にもなる。"
  type        = string
}

variable "ses_identity_arn" {
  description = "SES identity の ARN(modules/email の出力)。"
  type        = string
}

variable "ses_configuration_set_name" {
  description = "SES configuration set 名(modules/email の出力)。"
  type        = string
}

variable "ses_configuration_set_arn" {
  description = "SES configuration set の ARN(modules/email の出力)。"
  type        = string
}

variable "feedback_topic_arn" {
  description = "bounce/complaint が発行される SNS トピックの ARN(modules/email の出力)。"
  type        = string
}

variable "database_secret_arn" {
  description = "DB 接続文字列を保持する Secrets Manager の secret ARN(共通基盤 T-501 が作る)。値は Terraform の state に入れない。"
  type        = string
}

variable "subnet_ids" {
  description = "Lambda を VPC に接続する場合の private subnet。空なら VPC に接続しない(RDS へ接続するには共通基盤 T-501 の値が必要)。"
  type        = list(string)
  default     = []
}

variable "security_group_ids" {
  description = "Lambda を VPC に接続する場合の security group。"
  type        = list(string)
  default     = []
}

variable "delivery_max_concurrency" {
  description = "delivery の event source mapping の最大同時実行数(SES の送信レートと DB 接続数を保護する)。"
  type        = number
  default     = 5

  validation {
    condition     = var.delivery_max_concurrency >= 2
    error_message = "event source mapping の maximum_concurrency は 2 以上にする必要があります。"
  }
}

variable "log_retention_days" {
  description = "CloudWatch Logs の保持日数。"
  type        = number
  default     = 30
}

variable "alarm_actions" {
  description = "アラームの通知先に追加する ARN(モジュールが作る SNS トピックに加えて通知する)。"
  type        = list(string)
  default     = []
}
