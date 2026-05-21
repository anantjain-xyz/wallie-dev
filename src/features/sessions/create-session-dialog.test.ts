import { describe, expect, it } from "vitest";

import { isSessionSubmitShortcut } from "./create-session-dialog";

describe("isSessionSubmitShortcut", () => {
  it("matches Command+Enter", () => {
    expect(isSessionSubmitShortcut({ key: "Enter", metaKey: true })).toBe(true);
  });

  it("ignores Enter without Command", () => {
    expect(isSessionSubmitShortcut({ key: "Enter", metaKey: false })).toBe(false);
  });

  it("ignores other Command shortcuts", () => {
    expect(isSessionSubmitShortcut({ key: "k", metaKey: true })).toBe(false);
  });
});
