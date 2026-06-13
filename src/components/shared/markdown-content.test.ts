import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MarkdownContent } from "@/components/shared/markdown-content";

function render(markdown: string): string {
  return renderToStaticMarkup(createElement(MarkdownContent, null, markdown));
}

describe("MarkdownContent", () => {
  it("renders markdown structure as real typography", () => {
    const html = render("# Review\n\nPR #12 reviewed.\n\n- one\n- two");
    expect(html).toContain("<h1");
    expect(html).toContain("Review");
    expect(html).toContain("<ul");
    expect(html).toContain("<li");
    // The literal heading marker must not survive in the output.
    expect(html).not.toContain("# Review");
  });

  it("renders fenced code blocks and inline code", () => {
    const html = render("Use `npm test`.\n\n```\nconst x = 1;\n```");
    expect(html).toContain("<pre");
    expect(html).toContain("<code");
    expect(html).toContain("const x = 1;");
  });

  it("renders links as external anchors", () => {
    const html = render("[docs](https://example.com)");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain("noopener");
  });

  it("does not emit raw HTML embedded in untrusted markdown", () => {
    const html = render('Hello <script>alert(1)</script> <img src=x onerror="alert(2)">');
    expect(html).not.toContain("<script");
    expect(html).not.toContain("onerror");
  });

  it("strips dangerous URL schemes from links", () => {
    const html = render("[click](javascript:alert(1))");
    expect(html).not.toContain("javascript:alert");
  });
});
