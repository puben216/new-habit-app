output "notifications_queue_url" {
  description = "notifications queue の URL。"
  value       = aws_sqs_queue.notifications.url
}

output "notifications_dlq_arn" {
  description = "notifications DLQ の ARN。"
  value       = aws_sqs_queue.notifications_dlq.arn
}

output "feedback_dlq_arn" {
  description = "feedback DLQ の ARN。"
  value       = aws_sqs_queue.feedback_dlq.arn
}

output "unsubscribe_signing_key_secret_arn" {
  description = "配信停止 token の署名鍵を入れる secret の ARN(値は Terraform 外で投入する)。web 側(ECS)にも同じ鍵を渡す。"
  value       = aws_secretsmanager_secret.unsubscribe_signing_key.arn
}

output "alarm_topic_arn" {
  description = "アラームの通知先 SNS トピック(購読者は共通基盤 T-501 で接続する)。"
  value       = aws_sns_topic.alarms.arn
}

output "lambda_function_names" {
  description = "scheduler / delivery / feedback の関数名。"
  value       = { for name, fn in aws_lambda_function.this : name => fn.function_name }
}
