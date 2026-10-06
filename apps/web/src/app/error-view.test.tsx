import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ErrorView } from "./error-view";

describe("ErrorView", () => {
  it("固定文言と再試行ボタンを出し、error の message・stack・digest を描画しない", () => {
    const error = Object.assign(new Error("SECRET: relation users does not exist"), {
      digest: "digest-12345",
    });
    error.stack = "Error: SECRET\n    at /srv/app/secret-file.ts:10:5";

    const html = renderToStaticMarkup(<ErrorView error={error} reset={() => undefined} />);

    expect(html).toContain("問題が発生しました");
    expect(html).toContain("もう一度試す");
    expect(html).toContain('role="alert"');
    expect(html).not.toContain("SECRET");
    expect(html).not.toContain("secret-file");
    expect(html).not.toContain("digest-12345");
  });

  it("main landmark(skip link の移動先)の中に表示する", () => {
    const html = renderToStaticMarkup(<ErrorView error={new Error("x")} reset={() => undefined} />);
    expect(html).toContain('<main id="main-content"');
  });

  it("画面の主題として h1 を 1 つだけ持つ", () => {
    const html = renderToStaticMarkup(<ErrorView error={new Error("x")} reset={() => undefined} />);
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).not.toContain("<h2");
  });

  it("再試行ボタンは渡された reset を呼ぶ", () => {
    const reset = vi.fn();
    const tree = ErrorView({ error: new Error("x"), reset });

    const handlers = collectOnClickHandlers(tree);

    expect(handlers).toEqual([reset]);
  });
});

/** 要素木を辿り、props の onClick を集める(Button は関数コンポーネントのまま扱う)。 */
function collectOnClickHandlers(node: ReactNode): unknown[] {
  if (!isValidElement(node)) return [];
  const props = (
    node as ReactElement<{ onClick?: unknown; children?: ReactNode; action?: ReactNode }>
  ).props;
  const own = props.onClick === undefined ? [] : [props.onClick];
  const children = [props.children, props.action].flatMap((child) =>
    Array.isArray(child) ? child.flatMap(collectOnClickHandlers) : collectOnClickHandlers(child),
  );
  return [...own, ...children];
}
