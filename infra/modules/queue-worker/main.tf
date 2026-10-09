# 通知の配送基盤(docs/07-infrastructure.md、docs/specs/notification-delivery.md NDL-009)。
# EventBridge Scheduler(5 分間隔)→ scheduler Lambda → SQS(notifications)→ delivery Lambda → SES、
# SES の bounce/complaint → SNS → SQS(feedback)→ feedback Lambda。
# 各 queue に DLQ(受信 3 回で移動)と DLQ アラーム。IAM は Lambda ごとに最小権限。
# Secret の値は state に入れない(Secrets Manager の器のみ作る。値は別の安全な経路で投入する)。

locals {
  functions = {
    scheduler = {
      handler     = "handlers/reminder-scheduler.handler"
      timeout     = 60
      memory_size = 256
      reserved    = 1
    }
    delivery = {
      handler     = "handlers/reminder-delivery.handler"
      timeout     = 60
      memory_size = 256
      reserved    = var.delivery_max_concurrency
    }
    feedback = {
      handler     = "handlers/ses-feedback.handler"
      timeout     = 30
      memory_size = 256
      reserved    = 2
    }
  }

  use_vpc = length(var.subnet_ids) > 0

  # Lambda が必要とする環境変数だけを関数ごとに渡す(最小権限と同じ考え方)。
  environment = {
    scheduler = {
      NOTIFICATION_DELIVERY_ENABLED = tostring(var.delivery_enabled)
      DATABASE_URL_SECRET_ARN       = var.database_secret_arn
      NOTIFICATION_QUEUE_URL        = aws_sqs_queue.notifications.url
    }
    delivery = {
      NOTIFICATION_DELIVERY_ENABLED      = tostring(var.delivery_enabled)
      DATABASE_URL_SECRET_ARN            = var.database_secret_arn
      UNSUBSCRIBE_SIGNING_KEY_SECRET_ARN = aws_secretsmanager_secret.unsubscribe_signing_key.arn
      APP_BASE_URL                       = var.app_base_url
      EMAIL_FROM                         = var.email_from
      SES_CONFIGURATION_SET              = var.ses_configuration_set_name
    }
    feedback = {
      DATABASE_URL_SECRET_ARN = var.database_secret_arn
    }
  }
}

# ---- Secrets(器のみ。値は含めない)--------------------------------------------

resource "aws_secretsmanager_secret" "unsubscribe_signing_key" {
  name                    = "${var.name_prefix}/unsubscribe-signing-key"
  description             = "メール内の配信停止 token の HMAC 署名鍵(32 バイト以上)。値は Terraform 外で投入する。"
  recovery_window_in_days = 7
}

# ---- SQS(notifications / feedback、それぞれ DLQ つき)------------------------------

resource "aws_sqs_queue" "notifications_dlq" {
  name                      = "${var.name_prefix}-notifications-dlq"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue" "notifications" {
  name = "${var.name_prefix}-notifications"
  # Lambda の timeout の 6 倍以上(AWS の推奨)。
  visibility_timeout_seconds = local.functions.delivery.timeout * 6
  message_retention_seconds  = 345600
  sqs_managed_sse_enabled    = true

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.notifications_dlq.arn
    maxReceiveCount     = 3
  })
}

resource "aws_sqs_queue" "feedback_dlq" {
  name                      = "${var.name_prefix}-ses-feedback-dlq"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue" "feedback" {
  name                       = "${var.name_prefix}-ses-feedback"
  visibility_timeout_seconds = local.functions.feedback.timeout * 6
  message_retention_seconds  = 345600
  sqs_managed_sse_enabled    = true

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.feedback_dlq.arn
    maxReceiveCount     = 3
  })
}

data "aws_iam_policy_document" "feedback_queue" {
  statement {
    sid       = "AllowSnsDelivery"
    effect    = "Allow"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.feedback.arn]

    principals {
      type        = "Service"
      identifiers = ["sns.amazonaws.com"]
    }

    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [var.feedback_topic_arn]
    }
  }
}

resource "aws_sqs_queue_policy" "feedback" {
  queue_url = aws_sqs_queue.feedback.url
  policy    = data.aws_iam_policy_document.feedback_queue.json
}

resource "aws_sns_topic_subscription" "feedback" {
  topic_arn = var.feedback_topic_arn
  protocol  = "sqs"
  endpoint  = aws_sqs_queue.feedback.arn

  depends_on = [aws_sqs_queue_policy.feedback]
}

# ---- IAM(Lambda ごとに最小権限)------------------------------------------------

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "lambda" {
  for_each = local.functions

  name               = "${var.name_prefix}-${each.key}"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "vpc_access" {
  for_each = local.use_vpc ? local.functions : {}

  role       = aws_iam_role.lambda[each.key].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

data "aws_iam_policy_document" "scheduler" {
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.lambda["scheduler"].arn}:*"]
  }

  statement {
    sid       = "ReadDatabaseSecret"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [var.database_secret_arn]
  }

  statement {
    sid       = "EnqueueNotifications"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.notifications.arn]
  }
}

data "aws_iam_policy_document" "delivery" {
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.lambda["delivery"].arn}:*"]
  }

  statement {
    sid       = "ReadSecrets"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [var.database_secret_arn, aws_secretsmanager_secret.unsubscribe_signing_key.arn]
  }

  statement {
    sid = "ConsumeNotifications"
    actions = [
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:GetQueueAttributes",
      "sqs:ChangeMessageVisibility",
    ]
    resources = [aws_sqs_queue.notifications.arn]
  }

  statement {
    sid       = "SendReminderEmail"
    actions   = ["ses:SendEmail"]
    resources = [var.ses_identity_arn, var.ses_configuration_set_arn]

    condition {
      test     = "StringEquals"
      variable = "ses:FromAddress"
      values   = [var.email_from]
    }
  }
}

data "aws_iam_policy_document" "feedback" {
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.lambda["feedback"].arn}:*"]
  }

  statement {
    sid       = "ReadDatabaseSecret"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [var.database_secret_arn]
  }

  statement {
    sid = "ConsumeFeedback"
    actions = [
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:GetQueueAttributes",
      "sqs:ChangeMessageVisibility",
    ]
    resources = [aws_sqs_queue.feedback.arn]
  }
}

resource "aws_iam_role_policy" "scheduler" {
  name   = "scheduler"
  role   = aws_iam_role.lambda["scheduler"].id
  policy = data.aws_iam_policy_document.scheduler.json
}

resource "aws_iam_role_policy" "delivery" {
  name   = "delivery"
  role   = aws_iam_role.lambda["delivery"].id
  policy = data.aws_iam_policy_document.delivery.json
}

resource "aws_iam_role_policy" "feedback" {
  name   = "feedback"
  role   = aws_iam_role.lambda["feedback"].id
  policy = data.aws_iam_policy_document.feedback.json
}

# ---- Lambda ----------------------------------------------------------------

resource "aws_cloudwatch_log_group" "lambda" {
  for_each = local.functions

  name              = "/aws/lambda/${var.name_prefix}-${each.key}"
  retention_in_days = var.log_retention_days
}

resource "aws_lambda_function" "this" {
  for_each = local.functions

  function_name = "${var.name_prefix}-${each.key}"
  role          = aws_iam_role.lambda[each.key].arn
  runtime       = var.lambda_runtime
  handler       = each.value.handler
  architectures = ["arm64"]
  s3_bucket     = var.lambda_s3_bucket
  s3_key        = var.lambda_s3_key
  timeout       = each.value.timeout
  memory_size   = each.value.memory_size

  # DB 接続数と SES の送信レートを保護する(docs/07-infrastructure.md)。
  reserved_concurrent_executions = each.value.reserved

  environment {
    variables = local.environment[each.key]
  }

  dynamic "vpc_config" {
    for_each = local.use_vpc ? [1] : []

    content {
      subnet_ids         = var.subnet_ids
      security_group_ids = var.security_group_ids
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.lambda,
    aws_iam_role_policy.scheduler,
    aws_iam_role_policy.delivery,
    aws_iam_role_policy.feedback,
  ]
}

# スケジューラは冪等で次の周期(5 分後)に再実行されるため、Lambda 側の自動再試行は無効にする。
resource "aws_lambda_function_event_invoke_config" "scheduler" {
  function_name          = aws_lambda_function.this["scheduler"].function_name
  maximum_retry_attempts = 0
}

resource "aws_lambda_event_source_mapping" "delivery" {
  event_source_arn        = aws_sqs_queue.notifications.arn
  function_name           = aws_lambda_function.this["delivery"].arn
  batch_size              = 10
  function_response_types = ["ReportBatchItemFailures"]

  scaling_config {
    maximum_concurrency = var.delivery_max_concurrency
  }
}

resource "aws_lambda_event_source_mapping" "feedback" {
  event_source_arn        = aws_sqs_queue.feedback.arn
  function_name           = aws_lambda_function.this["feedback"].arn
  batch_size              = 10
  function_response_types = ["ReportBatchItemFailures"]

  scaling_config {
    maximum_concurrency = 2
  }
}

# ---- EventBridge Scheduler(5 分間隔。停止手段は schedule_enabled = false)------------

data "aws_iam_policy_document" "scheduler_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "schedule" {
  name               = "${var.name_prefix}-reminder-schedule"
  assume_role_policy = data.aws_iam_policy_document.scheduler_assume.json
}

data "aws_iam_policy_document" "schedule_invoke" {
  statement {
    actions   = ["lambda:InvokeFunction"]
    resources = [aws_lambda_function.this["scheduler"].arn]
  }
}

resource "aws_iam_role_policy" "schedule_invoke" {
  name   = "invoke-scheduler"
  role   = aws_iam_role.schedule.id
  policy = data.aws_iam_policy_document.schedule_invoke.json
}

resource "aws_scheduler_schedule" "reminders" {
  name                = "${var.name_prefix}-reminder-scan"
  description         = "送信枠に達した通知設定を走査して配送を作る(5 分間隔)。"
  schedule_expression = "rate(5 minutes)"
  state               = var.schedule_enabled ? "ENABLED" : "DISABLED"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_lambda_function.this["scheduler"].arn
    role_arn = aws_iam_role.schedule.arn

    retry_policy {
      maximum_retry_attempts = 0
    }
  }
}

# ---- 監視(DLQ、滞留、Lambda エラー)--------------------------------------------

resource "aws_sns_topic" "alarms" {
  name = "${var.name_prefix}-notification-alarms"
}

locals {
  alarm_actions = concat([aws_sns_topic.alarms.arn], var.alarm_actions)
}

resource "aws_cloudwatch_metric_alarm" "dlq_not_empty" {
  for_each = {
    notifications = aws_sqs_queue.notifications_dlq.name
    feedback      = aws_sqs_queue.feedback_dlq.name
  }

  alarm_name          = "${var.name_prefix}-${each.key}-dlq-not-empty"
  alarm_description   = "DLQ にメッセージがある(Runbook: docs/runbooks/notification-delivery.md)。"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions

  dimensions = {
    QueueName = each.value
  }
}

resource "aws_cloudwatch_metric_alarm" "notifications_oldest_message" {
  alarm_name          = "${var.name_prefix}-notifications-oldest-message-age"
  alarm_description   = "notifications queue の最古のメッセージが 30 分を超えて滞留している。"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateAgeOfOldestMessage"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1800
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions

  dimensions = {
    QueueName = aws_sqs_queue.notifications.name
  }
}

resource "aws_cloudwatch_metric_alarm" "lambda_errors" {
  for_each = local.functions

  alarm_name          = "${var.name_prefix}-${each.key}-errors"
  alarm_description   = "${each.key} Lambda でエラーが発生した。"
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions

  dimensions = {
    FunctionName = aws_lambda_function.this[each.key].function_name
  }
}
