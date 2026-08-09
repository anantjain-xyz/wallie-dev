import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MarkdownContent } from "@/components/shared/markdown-content";
import { renderMarkdown, renderMarkdownToHtml } from "@/components/shared/markdown-content.server";
import {
  ARTIFACT_FIXTURE_EMPTY,
  ARTIFACT_FIXTURE_FAILED,
  ARTIFACT_FIXTURE_FULL_MARKDOWN,
  ARTIFACT_FIXTURE_HOSTILE,
  ARTIFACT_FIXTURE_PLAIN_TEXT,
  ARTIFACT_FIXTURE_RAW_JSON,
} from "@/features/sessions/detail/artifact-fixtures";

function render(markdown: string): string {
  return renderMarkdownToHtml(markdown);
}

function renderReader(markdown: string): string {
  return renderToStaticMarkup(
    createElement(MarkdownContent, { html: renderMarkdown(markdown).bodyHtml }),
  );
}

describe("MarkdownContent fixtures", () => {
  it("renders every supported Markdown element with document hierarchy", () => {
    const html = render(ARTIFACT_FIXTURE_FULL_MARKDOWN);

    expect(html).toContain('class="artifact-content"');
    expect(html).toContain('class="artifact-heading-1"');
    expect(html).toContain('class="artifact-heading-2"');
    expect(html).toContain('class="artifact-heading-3"');
    expect(html).toContain('class="artifact-heading-4"');
    expect(html).toContain("<strong");
    expect(html).toContain("<em");
    expect(html).toContain("artifact-inline-code");
    expect(html).toContain("<blockquote");
    expect(html).toContain("<ul");
    expect(html).toContain("<ol");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("<table");
    expect(html).toContain('aria-label="Table"');
    expect(html).toContain("artifact-table-scroll");
    expect(html).toContain("artifact-pre");
    expect(html).toContain("artifact-code-block");
    expect(html).toContain('href="https://example.com/docs"');
    expect(html).toContain('href="https://example.com/diagram.png"');
    expect(html).not.toContain("<img");
    expect(html).toContain("<hr");
    expect(html).not.toContain("# Heading One");
  });

  it("strips hostile content while preserving readable text", () => {
    const html = render(ARTIFACT_FIXTURE_HOSTILE);
    expect(html).not.toContain("<script");
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("<img");
    expect(html).toContain("Hello");
    expect(html).toContain('href="https://attacker.example/track.png"');
  });

  it("handles empty Markdown without crashing", () => {
    expect(render(ARTIFACT_FIXTURE_EMPTY)).toContain('class="artifact-content"');
  });

  it("renders plain text as a paragraph", () => {
    const html = render(ARTIFACT_FIXTURE_PLAIN_TEXT);
    expect(html).toContain("<p");
    expect(html).toContain("Just a plain-text artifact");
  });

  it("exposes raw JSON and failed artifact fixtures as structured data for Raw views", () => {
    expect(JSON.stringify(ARTIFACT_FIXTURE_RAW_JSON)).toContain('"status":"ok"');
    expect(ARTIFACT_FIXTURE_FAILED.error).toContain("Agent run failed");
  });
});

describe("renderMarkdownToHtml", () => {
  it.each([
    ["supported elements", ARTIFACT_FIXTURE_FULL_MARKDOWN],
    ["hostile content", ARTIFACT_FIXTURE_HOSTILE],
    ["plain text", ARTIFACT_FIXTURE_PLAIN_TEXT],
    ["empty Markdown", ARTIFACT_FIXTURE_EMPTY],
  ])("serves the same canonical rendering to the reader and API for %s", (_name, markdown) => {
    expect(renderMarkdownToHtml(markdown)).toBe(renderReader(markdown));
  });
});
