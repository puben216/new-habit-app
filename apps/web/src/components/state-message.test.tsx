import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { StateMessage } from "./state-message";

describe("StateMessage", () => {
  it("loading は role=status、error は role=alert、empty は role なし", () => {
    expect(renderToStaticMarkup(<StateMessage kind="loading" title="t" />)).toContain(
      'role="status"',
    );
    expect(renderToStaticMarkup(<StateMessage kind="error" title="t" />)).toContain('role="alert"');
    expect(renderToStaticMarkup(<StateMessage kind="empty" title="t" />)).not.toContain("role=");
  });

  it("種類を色だけでなく文字ラベルでも示す", () => {
    expect(renderToStaticMarkup(<StateMessage kind="loading" title="t" />)).toContain("読み込み中");
    expect(renderToStaticMarkup(<StateMessage kind="empty" title="t" />)).toContain("データなし");
    expect(renderToStaticMarkup(<StateMessage kind="error" title="t" />)).toContain("エラー");
  });

  it("title、description、action を表示し、省略した要素は出さない", () => {
    const full = renderToStaticMarkup(
      <StateMessage
        kind="empty"
        title="タイトル"
        description="説明"
        action={<button type="button">操作</button>}
      />,
    );
    expect(full).toContain("<h2");
    expect(full).toContain("タイトル");
    expect(full).toContain("説明");
    expect(full).toContain("操作");

    const minimal = renderToStaticMarkup(<StateMessage kind="empty" title="タイトル" />);
    expect(minimal.match(/<p/g)).toHaveLength(1);
    expect(minimal).not.toContain("<button");
  });

  it("文言は HTML としてエスケープされる(XSS)", () => {
    const html = renderToStaticMarkup(
      <StateMessage kind="error" title={"<img src=x onerror=alert(1)>"} />,
    );
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("見出しは既定で h2、headingLevel=1 で h1 になる", () => {
    expect(renderToStaticMarkup(<StateMessage kind="empty" title="t" />)).toContain("<h2");
    const single = renderToStaticMarkup(<StateMessage kind="empty" title="t" headingLevel={1} />);
    expect(single).toContain("<h1");
    expect(single).not.toContain("<h2");
  });
});
