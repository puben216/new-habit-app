import { InvalidPasswordError } from "./errors";

const MIN_LENGTH = 8;
const MAX_LENGTH = 128;

const CONTROL_CHAR_PATTERN = new RegExp("[\\u0000-\\u001f\\u007f]");

/**
 * password が policy(docs/specs/auth-adapter.md AUTH-002)を満たすか検証する。
 *
 * 文字数判定は trim 後の長さで行うが、password 自体は変更しない
 * (先頭・末尾の空白も password の一部としてハッシュ化・照合に使うため)。
 */
export function assertPasswordPolicy(password: string): void {
  const trimmedLength = password.trim().length;

  if (trimmedLength < MIN_LENGTH || trimmedLength > MAX_LENGTH) {
    throw new InvalidPasswordError(
      `password は先頭・末尾の空白を除いて ${MIN_LENGTH}〜${MAX_LENGTH} 文字である必要があります`,
    );
  }

  if (CONTROL_CHAR_PATTERN.test(password)) {
    throw new InvalidPasswordError("password に制御文字を含めることはできません");
  }
}
