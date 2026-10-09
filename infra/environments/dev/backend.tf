# remote state は環境別の S3(versioning + 暗号化)。バケット名などは `terraform init -backend-config=...` で渡す
# (state バケット自体は共通基盤 T-501 で作る。ここにアカウント固有の値を書かない)。
terraform {
  backend "s3" {}
}
