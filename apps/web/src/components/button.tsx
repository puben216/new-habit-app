import type { ButtonHTMLAttributes } from "react";

import styles from "./button.module.css";

export type ButtonVariant = "primary" | "secondary";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
}

/** `type` の既定を `button` にする(form 内で意図せず submit されないため)。 */
export function Button({ variant = "primary", type = "button", className, ...rest }: ButtonProps) {
  const classNames = [styles["button"], styles[variant], className].filter(Boolean).join(" ");
  return <button type={type} className={classNames} {...rest} />;
}
