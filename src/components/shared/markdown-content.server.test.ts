import { describe, expect, it } from "vitest";

import { renderMarkdownToHtml } from "@/components/shared/markdown-content.server";

describe("renderMarkdownToHtml", () => {
  it("uses the same semantic artifact roles as the React renderer", async () => {
    const html = await renderMarkdownToHtml(
      "# One\n\n## Two\n\n### Three\n\nUse `pnpm check`.\n\n```ts\nconst ready = true;\n```",
    );

    expect(html).toContain('class="artifact-content"');
    expect(html).not.toContain("max-h-[480px]");
    expect(html).not.toContain("overflow-auto");
    expect(html).toContain('class="artifact-heading-1"');
    expect(html).toContain('class="artifact-heading-2"');
    expect(html).toContain('class="artifact-heading-3"');
    expect(html).toContain('class="artifact-inline-code"');
    expect(html).toContain("artifact-pre");
    expect(html).toContain("artifact-code-block");
  });
});
