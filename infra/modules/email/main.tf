# SES(docs/07-infrastructure.md、docs/adr/ADR-005-email.md)。
# domain verification と DKIM、bounce/complaint の通知(SNS)を定義する。
# 注意: DKIM の CNAME、SPF、DMARC の DNS レコードはこのモジュールでは作らない(ドメインの管理元に依存するため)。
# `dkim_tokens` 出力を使って、ドメインの管理元で設定する。

data "aws_caller_identity" "current" {}

resource "aws_sesv2_email_identity" "domain" {
  email_identity = var.domain

  dkim_signing_attributes {
    next_signing_key_length = "RSA_2048_BIT"
  }
}

resource "aws_sesv2_configuration_set" "this" {
  configuration_set_name = "${var.name_prefix}-reminders"

  delivery_options {
    tls_policy = "REQUIRE"
  }

  reputation_options {
    reputation_metrics_enabled = true
  }

  sending_options {
    sending_enabled = true
  }

  suppression_options {
    suppressed_reasons = ["BOUNCE", "COMPLAINT"]
  }
}

# bounce/complaint の通知先。KMS の CMK による暗号化は共通基盤(T-501)で追加する
# (SES から発行するトピックには AWS マネージドキーを使えないため、CMK が必要)。
resource "aws_sns_topic" "feedback" {
  name = "${var.name_prefix}-ses-feedback"
}

data "aws_iam_policy_document" "feedback_topic" {
  statement {
    sid       = "AllowSesPublish"
    effect    = "Allow"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.feedback.arn]

    principals {
      type        = "Service"
      identifiers = ["ses.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }

    condition {
      test     = "ArnLike"
      variable = "AWS:SourceArn"
      values   = ["arn:aws:ses:*:${data.aws_caller_identity.current.account_id}:configuration-set/${aws_sesv2_configuration_set.this.configuration_set_name}"]
    }
  }
}

resource "aws_sns_topic_policy" "feedback" {
  arn    = aws_sns_topic.feedback.arn
  policy = data.aws_iam_policy_document.feedback_topic.json
}

resource "aws_sesv2_configuration_set_event_destination" "feedback" {
  configuration_set_name = aws_sesv2_configuration_set.this.configuration_set_name
  event_destination_name = "feedback"

  event_destination {
    enabled              = true
    matching_event_types = ["BOUNCE", "COMPLAINT"]

    sns_destination {
      topic_arn = aws_sns_topic.feedback.arn
    }
  }

  depends_on = [aws_sns_topic_policy.feedback]
}

# アドレス単位の suppression の backstop(docs/specs/notification-delivery.md 未決事項)。
resource "aws_sesv2_account_suppression_attributes" "this" {
  count = var.manage_account_suppression ? 1 : 0

  suppressed_reasons = ["BOUNCE", "COMPLAINT"]
}
