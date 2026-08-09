import { describe, expect, it } from "vitest";

import { normalizeSessionAttachmentFileName } from "./session-attachment";

describe("normalizeSessionAttachmentFileName", () => {
  it("truncates by Unicode code point without splitting a surrogate pair", () => {
    const normalized = normalizeSessionAttachmentFileName(
      `${"a".repeat(254)}😀-trailing.png`,
      "image/png",
    );

    expect(Array.from(normalized)).toHaveLength(255);
    expect(normalized.endsWith("😀")).toBe(true);
    expect(() => encodeURIComponent(normalized)).not.toThrow();
  });
});
