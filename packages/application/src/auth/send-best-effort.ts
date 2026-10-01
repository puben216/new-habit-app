/**
 * AUTH-INV-002(enumeration対策)を守るため、通知メール送信の失敗を外部応答に反映させない。
 * signUp/resendVerification/requestPasswordReset は account 作成/token 発行が成功した時点で
 * 応答を確定させ、メール配送自体の成否(SMTP 障害等)によって応答(200番台/500番台)が
 * 変わらないようにする。配送失敗の可観測性(telemetry)は Observability 節の対象として別途整備する。
 */
export async function sendBestEffort(send: () => Promise<void>): Promise<void> {
  try {
    await send();
  } catch (error) {
    console.error("auth: 通知メール送信に失敗しました(処理は継続)", error);
  }
}
