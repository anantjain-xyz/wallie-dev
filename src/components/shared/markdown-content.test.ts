import { describe, expect, it } from "vitest";

import {
  mayContainEvidenceLinks,
  renderMarkdownToHtml,
} from "@/components/shared/markdown-content.server";

function render(markdown: string): string {
  return renderMarkdownToHtml(markdown);
}

describe("renderMarkdownToHtml", () => {
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
    expect(html).toContain('role="group"');
    expect(html).not.toContain('role="region"');
    expect(html).toContain('tabindex="0"');
  });

  it("keeps multiple code blocks focusable without duplicate region landmarks", () => {
    const html = render("```ts\nconst one = 1;\n```\n\n```ts\nconst two = 2;\n```");

    expect(html.match(/aria-label="Code block"/gu)).toHaveLength(2);
    expect(html.match(/role="group"/gu)).toHaveLength(2);
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

describe("artifact evidence links", () => {
  it.each([
    "/vercel/sandbox/docs/evidence/comments-toggle-pr-description.md",
    "https://www.wallie.dev/vercel/sandbox/docs/evidence/comments-toggle-pr-description.md",
    "//wallie.dev/vercel/sandbox/docs/evidence/comments-toggle-pr-description.md",
    "https://wallie.dev/%2Ftmp/evidence.md",
    "https://wallie.dev//vercel/sandbox/docs/evidence.md",
    "https://wallie.dev//vercel//sandbox/docs/evidence.md",
    "./vercel/sandbox/review.md",
    "../../vercel/sandbox/review.md",
    "/other/../vercel/sandbox/review.md",
    "/vercel%252Fsandbox/review.md",
    "/vercel/sandbox%2Freview.md",
    "/tmp/review.md",
    "/home/agent/review.md",
    "/Users/agent/review.md",
    "/workspace/review.md",
    "/mnt/data/review.md",
    "file:///vercel/sandbox/review.md",
    "sandbox:/mnt/data/review.md",
    "C:/sandbox/review.md",
  ])("shows unavailable evidence instead of a website link for %s", (destination) => {
    const html = render(`[PR description and evidence](${destination})`);

    expect(html).toContain("PR description and evidence (Evidence unavailable)");
    expect(html).toContain("Temporary sandbox files cannot be opened after the run.");
    expect(html).toContain('aria-disabled="true"');
    expect(html).not.toContain("<a");
    expect(html).not.toContain("href=");
  });

  it.each([
    "https://example.com/vercel/sandbox/review.md",
    "https://example.com//vercel/sandbox/review.md",
    "https://example.com/%2Ftmp/evidence.md",
    "https://github.com/owner/repository/blob/abc123/docs/review.md",
    "docs/evidence/review.md",
    "./docs/review.md",
    "../docs/review.md",
    "home/review.md",
    "/docs/review.md",
    "#validation",
    "mailto:reviewer@example.com",
  ])("preserves safe external, repository, anchor, and document links: %s", (destination) => {
    const html = render(`[Review](${destination})`);

    expect(html).toContain(`href="${destination}"`);
    expect(html).not.toContain("Evidence unavailable");
  });

  it.each([
    "wallie-evidence:checks/report",
    "WALLIE-EVIDENCE:checks/report",
    "wallie%2Devidence:checks/report",
    "wallie&#x2D;evidence:checks/report",
  ])(
    "resolves a durable evidence identity only through the supplied artifact mapping: %s",
    (alias) => {
      const destination =
        "/api/sessions/session-id/validation-evidence/assets/asset-id?artifactId=artifact-id";
      const html = renderMarkdownToHtml(
        `[Review report](${alias})`,
        false,
        new Map([["wallie-evidence:checks/report", destination]]),
      );

      expect(html).toContain(`href="${destination}"`);
      expect(html).toContain("Review report");
      expect(html).not.toContain("Evidence unavailable");
      expect(html).not.toContain("wallie-evidence:");
    },
  );

  it("shows unavailable evidence when no retained identity matches", () => {
    const html = renderMarkdownToHtml(
      "[Review report](wallie-evidence:checks/report)",
      false,
      new Map([["wallie-evidence:other/report", "/api/sessions/other/assets/other"]]),
    );

    expect(html).toContain("Review report (Evidence unavailable)");
    expect(html).not.toContain("<a");
    expect(html).not.toContain("/api/sessions/other");
  });

  it("keeps local images unavailable and durable images click-only", () => {
    const destination =
      "/api/sessions/session-id/validation-evidence/assets/asset-id?artifactId=artifact-id";
    const html = renderMarkdownToHtml(
      "![Legacy screenshot](/vercel/sandbox/screen.png)\n\n![Retained screenshot](wallie-evidence:checks/screen)",
      false,
      new Map([["wallie-evidence:checks/screen", destination]]),
    );

    expect(html).toContain("🖼 Legacy screenshot (Evidence unavailable)");
    expect(html).toContain(`href="${destination}"`);
    expect(html).toContain("🖼 Retained screenshot");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("/vercel/sandbox");
    expect(html).not.toContain("preload");
  });

  it("sanitizes resolved destinations and preserves source coordinates on the original label", () => {
    const html = renderMarkdownToHtml(
      "[Review report](wallie-evidence:checks/report)",
      true,
      new Map([["wallie-evidence:checks/report", "javascript:alert(1)"]]),
    );

    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("href=");
    expect(html).toContain('data-review-text-start="1"');
    expect(html).toContain('data-review-text-end="14"');
    expect(html).toContain("Review report");
  });
});

describe("mayContainEvidenceLinks", () => {
  it.each([
    "[Review report](wallie-evidence:checks/report)",
    "[Review report](WALLIE-EVIDENCE:checks/report)",
    "[Review report](wallie%2Devidence:checks/report)",
    "[Review report](wallie&#x2D;evidence:checks/report)",
  ])("does not skip a scheme the renderer resolves: %s", (markdown) => {
    expect(mayContainEvidenceLinks(markdown)).toBe(true);
  });

  it.each(["A plain artifact", "[Docs](https://example.com/docs)", "[Local](../docs/review.md)"])(
    "skips evidence loading for ordinary Markdown: %s",
    (markdown) => {
      expect(mayContainEvidenceLinks(markdown)).toBe(false);
    },
  );
});
