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
    expect(html).toContain('class="artifact-content"');
    expect(html).toContain('class="artifact-heading-1"');
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
    expect(html).toContain("artifact-inline-code");
    expect(html).toContain("artifact-pre");
    expect(html).toContain("artifact-code-block");
    expect(html).toContain('aria-label="Code block"');
    expect(html).not.toContain('role="region"');
    expect(html).toContain('tabindex="0"');
  });

  it("keeps multiple code blocks focusable without duplicate region landmarks", () => {
    const html = render("```ts\nconst one = 1;\n```\n\n```ts\nconst two = 2;\n```");

    expect(html.match(/aria-label="Code block"/gu)).toHaveLength(2);
    expect(html.match(/tabindex="0"/gu)).toHaveLength(2);
    expect(html).not.toContain('role="region"');
  });

  it("uses materially distinct semantic classes for artifact heading levels", () => {
    const html = render("# One\n\n## Two\n\n### Three\n\n#### Four");
    expect(html).toContain('class="artifact-heading-1"');
    expect(html).toContain('class="artifact-heading-2"');
    expect(html).toContain('class="artifact-heading-3"');
    expect(html).toContain('class="artifact-heading-4"');
  });

  it("renders GFM tables and task lists", () => {
    const html = render("| A | B |\n| - | - |\n| x | y |\n\n- [x] shipped\n- [ ] pending");
    expect(html).toContain("<table");
    expect(html).toContain("<th");
    expect(html).toContain('aria-label="Table"');
    expect(html).toContain('role="region"');
    expect(html).toContain("artifact-table-scroll");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("shipped");
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

  it("does not allow encoded dangerous URLs or HTML event handlers", () => {
    const html = render(
      '[click](jav&#x61;script:alert(1)) <a href="https://safe.example" onclick="alert(2)">safe</a>',
    );
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("onclick");
  });

  it("renders images as click-only links so untrusted markdown can't auto-fetch remote URLs", () => {
    const html = render("![alt text](https://attacker.example/track.png)");
    // No auto-loading <img> and no resource-fetching preload hint.
    expect(html).not.toContain("<img");
    expect(html).not.toContain('rel="preload"');
    // The URL is preserved as an explicit external anchor the reviewer can choose to open.
    expect(html).toContain('href="https://attacker.example/track.png"');
    expect(html).toContain("alt text");
  });
});
