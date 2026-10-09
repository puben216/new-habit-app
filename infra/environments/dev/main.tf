# dev 環境: 通知の配送に必要なモジュールだけを呼ぶ最小構成(T-402)。
# network / RDS / ECS / KMS などの共通基盤は T-501 で追加する。apply はレビューと承認の後に行う。

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project     = "habit-app"
      Environment = "dev"
      ManagedBy   = "terraform"
      Component   = "notifications"
    }
  }
}

locals {
  name_prefix = "habit-app-dev"
}

module "email" {
  source = "../../modules/email"

  name_prefix                = local.name_prefix
  domain                     = var.domain
  manage_account_suppression = true
}

module "notifications" {
  source = "../../modules/queue-worker"

  name_prefix                = local.name_prefix
  lambda_s3_bucket           = var.lambda_s3_bucket
  lambda_s3_key              = var.lambda_s3_key
  delivery_enabled           = var.delivery_enabled
  schedule_enabled           = var.schedule_enabled
  app_base_url               = var.app_base_url
  email_from                 = var.email_from
  ses_identity_arn           = module.email.identity_arn
  ses_configuration_set_name = module.email.configuration_set_name
  ses_configuration_set_arn  = module.email.configuration_set_arn
  feedback_topic_arn         = module.email.feedback_topic_arn
  database_secret_arn        = var.database_secret_arn
  subnet_ids                 = var.subnet_ids
  security_group_ids         = var.security_group_ids
}
