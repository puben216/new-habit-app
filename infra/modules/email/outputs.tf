output "identity_arn" {
  description = "SES ドメイン identity の ARN(送信権限の絞り込みに使う)。"
  value       = aws_sesv2_email_identity.domain.arn
}

output "dkim_tokens" {
  description = "ドメインの管理元に CNAME(<token>._domainkey.<domain> → <token>.dkim.amazonses.com)として登録する DKIM トークン。"
  value       = aws_sesv2_email_identity.domain.dkim_signing_attributes[0].tokens
}

output "configuration_set_name" {
  description = "送信時に指定する configuration set 名。"
  value       = aws_sesv2_configuration_set.this.configuration_set_name
}

output "configuration_set_arn" {
  description = "configuration set の ARN(送信権限の絞り込みに使う)。"
  value       = aws_sesv2_configuration_set.this.arn
}

output "feedback_topic_arn" {
  description = "bounce/complaint が発行される SNS トピックの ARN。"
  value       = aws_sns_topic.feedback.arn
}
