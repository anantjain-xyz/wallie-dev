import { describe, expect, it } from "vitest";

import { formatSentenceCaseLabel } from "@/lib/labels";

describe("formatSentenceCaseLabel", () => {
  it("normalizes raw enum values to sentence case labels", () => {
    expect(formatSentenceCaseLabel("running")).toBe("Running");
    expect(formatSentenceCaseLabel("awaiting_review")).toBe("Awaiting review");
    expect(formatSentenceCaseLabel("not-set-up")).toBe("Not set up");
  });

  it("preserves common product and technical acronyms", () => {
    expect(formatSentenceCaseLabel("setup PR open")).toBe("Setup PR open");
    expect(formatSentenceCaseLabel("ChatGPT subscription")).toBe("ChatGPT subscription");
    expect(formatSentenceCaseLabel("openai_api_key")).toBe("OpenAI API key");
  });
});
