import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ErrorSummary } from "./error-summary";
import { TextField } from "./text-field";

describe("TextField", () => {
  it("label を input に関連付け、エラーがなければ aria-invalid / aria-describedby を付けない", () => {
    const html = renderToStaticMarkup(<TextField id="email" name="email" label="メールアドレス" />);

    expect(html).toContain('<label for="email"');
    expect(html).toContain('id="email"');
    expect(html).not.toContain("aria-invalid");
    expect(html).not.toContain("aria-describedby");
  });

  it("hint とエラーを aria-describedby で関連付け、aria-invalid を付ける", () => {
    const html = renderToStaticMarkup(
      <TextField
        id="password"
        name="password"
        label="パスワード"
        hint="8文字以上"
        error="入力してください"
      />,
    );

    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('aria-describedby="password-hint password-error"');
    expect(html).toContain('id="password-hint"');
    expect(html).toContain('id="password-error"');
    expect(html).toContain("入力してください");
  });

  it("エラーは色だけでなく文字でも示す", () => {
    const html = renderToStaticMarkup(<TextField id="a" name="a" label="A" error="NG" />);
    expect(html).toContain("エラー: ");
  });

  it("エラー文言は HTML としてエスケープされる", () => {
    const html = renderToStaticMarkup(
      <TextField id="a" name="a" label="A" error={"<img src=x onerror=alert(1)>"} />,
    );
    expect(html).not.toContain("<img");
  });
});

describe("ErrorSummary", () => {
  it("項目がなければ何も描画しない", () => {
    expect(renderToStaticMarkup(<ErrorSummary items={[]} attempt={0} />)).toBe("");
  });

  it("role=alert で、項目のエラーは入力欄へのリンク、フォーム全体のエラーはリンクにしない", () => {
    const html = renderToStaticMarkup(
      <ErrorSummary
        attempt={1}
        items={[
          { fieldId: "email", message: "メールを入力してください" },
          { message: "通信に失敗しました" },
        ]}
      />,
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain('<a href="#email">メールを入力してください</a>');
    expect(html).toContain("<li>通信に失敗しました</li>");
  });
});
