import { describe, expect, it } from "vitest";

import { getLinearUrlError, isSessionSubmitShortcut } from "./create-session-dialog";

describe("isSessionSubmitShortcut", () => {
  it("matches Command+Enter", () => {
    expect(isSessionSubmitShortcut({ ctrlKey: false, key: "Enter", metaKey: true })).toBe(true);
  });

  it("matches Ctrl+Enter", () => {
    expect(isSessionSubmitShortcut({ ctrlKey: true, key: "Enter", metaKey: false })).toBe(true);
  });

  it("ignores Enter without a shortcut modifier", () => {
    expect(isSessionSubmitShortcut({ ctrlKey: false, key: "Enter", metaKey: false })).toBe(false);
  });

  it("ignores other Command shortcuts", () => {
    expect(isSessionSubmitShortcut({ ctrlKey: false, key: "k", metaKey: true })).toBe(false);
  });

  it("ignores other Ctrl shortcuts", () => {
    expect(isSessionSubmitShortcut({ ctrlKey: true, key: "k", metaKey: false })).toBe(false);
  });
});

describe("getLinearUrlError", () => {
  it("accepts empty and Linear URLs", () => {
    expect(getLinearUrlError("  ")).toBeNull();
    expect(getLinearUrlError("https://linear.app/acme/issue/TEAM-42/title")).toBeNull();
    expect(getLinearUrlError("https://custom.linear.app/acme/issue/TEAM-42/title")).toBeNull();
  });

  it("rejects non-Linear URLs", () => {
    expect(getLinearUrlError("https://example.com/acme/issue/TEAM-42")).toBe(
      "Must be a linear.app URL.",
    );
  });
});
