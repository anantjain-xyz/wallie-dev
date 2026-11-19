import { describe, expect, it } from "vitest";

import { renderConversationMarkdown } from "@/components/shared/markdown-content.server";

import {
  renderFactoryReadMarkdown,
  safeFactoryReadSourceHref,
  safeFactoryReadText,
} from "./output";

const token = `wallie_oa_936bce28-0440-42ef-9edf-fc26befdf0d8.${"a".repeat(43)}`;

describe("programmable read output", () => {
  it("preserves the public source location while removing query and fragment values", () => {
    expect(
      safeFactoryReadSourceHref("https://linear.app/wallie/issue/OP-570?token=private#secret"),
    ).toBe("https://linear.app/wallie/issue/OP-570");
  });

  it.each([
    null,
    "javascript:alert(1)",
    "/api/sessions/1/attachments/2",
    "https://name:password@github.com/anantjain-xyz/wallie-dev",
    "https://127.0.0.1:8000/read",
    "https://[::1]/read",
    "https://private.project.supabase.co/object/sign/image?token=private",
    "https://wallie.dev/api/sessions/1/validation-evidence/assets/2",
    "https://wallie.dev/%2573torage/v1/object/sign/images/private.png",
    `https://example.com/callback/${token}`,
  ])("withholds unsafe source %s", (url) => {
    expect(safeFactoryReadSourceHref(url)).toBeNull();
  });

  it("redacts credentials and private URLs in serialized free text", () => {
    expect(
      safeFactoryReadText(
        `Draft ${token} https://storage.googleapis.com/private/preview.png?signature=private data:image/png;base64,SGVsbG8=`,
      ),
    ).toBe("Draft [redacted] [link unavailable] [link unavailable]");
  });

  it("preserves readable Markdown without disclosing private media or decoded credentials", () => {
    const html = renderFactoryReadMarkdown(
      [
        "# Specification",
        "[Design discussion](https://example.com/design?X-Amz-Signature=private)",
        "[Private evidence](https://wallie.dev/api/sessions/42/attachments/58)",
        "![Preview screenshot](https://private.example.net/preview.png)",
        token.replace("wallie_", "wallie&#95;"),
        `\`\`\`${token}\nExample code\n\`\`\``,
        "<script>alert('injected')</script>",
      ].join("\n\n"),
    );
    expect(html).toContain("Specification");
    expect(html).toContain('href="https://example.com/design"');
    expect(html).toContain("Design discussion");
    expect(html).toContain("Private evidence");
    expect(html).toContain("Preview screenshot");
    expect(html).toContain("<code>Example code");
    expect(html).toContain("[redacted]");
    expect(html).not.toMatch(
      /X-Amz-Signature|attachments\/58|preview\.png|wallie_oa_|<img|injected/,
    );
    expect(renderConversationMarkdown("[Browser link](https://example.com/p?a=b)")).toContain(
      'href="https://example.com/p?a=b"',
    );
  });
});
