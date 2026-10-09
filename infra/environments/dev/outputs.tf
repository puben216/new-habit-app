output "dkim_tokens" {
  description = "ドメインの管理元に CNAME として登録する DKIM トークン。"
  value       = module.email.dkim_tokens
}

output "unsubscribe_signing_key_secret_arn" {
  description = "配信停止 token の署名鍵の secret ARN(値は Terraform 外で投入する)。"
  value       = module.notifications.unsubscribe_signing_key_secret_arn
}

output "notifications_queue_url" {
  description = "notifications queue の URL。"
  value       = module.notifications.notifications_queue_url
}

output "alarm_topic_arn" {
  description = "アラームの通知先 SNS トピック。"
  value       = module.notifications.alarm_topic_arn
}
