import { describe, expect, it } from "vitest";

import {
  getEmailCodeDigitUpdate,
  normalizeCompleteEmailCode,
} from "@/components/auth/email-code-inputs";

describe("normalizeCompleteEmailCode", () => {
  it.each([
    ["526316", "526316"],
    ["526 316", "526316"],
    ["526-316", "526316"],
    [" 526 - 316 ", "526316"],
  ])("normalizes complete code text %#", (value, expected) => {
    expect(normalizeCompleteEmailCode(value)).toBe(expected);
  });

  it.each(["52631", "5263167", "code: 526316", "abc", ""])(
    "does not treat ambiguous text as a complete code %#",
    (value) => {
      expect(normalizeCompleteEmailCode(value)).toBeNull();
    },
  );
});

describe("getEmailCodeDigitUpdate", () => {
  it.each([0, 1, 3, 5])(
    "starts a complete code paste at the first digit from index %s",
    (index) => {
      expect(getEmailCodeDigitUpdate(index, "526316")).toEqual({
        clearExistingDigits: true,
        digits: "526316",
        startIndex: 0,
      });
    },
  );

  it("normalizes formatted complete code pastes", () => {
    expect(getEmailCodeDigitUpdate(4, "526-316")).toEqual({
      clearExistingDigits: true,
      digits: "526316",
      startIndex: 0,
    });
  });

  it("keeps partial multi-digit input anchored to the focused digit", () => {
    expect(getEmailCodeDigitUpdate(2, "526")).toEqual({
      clearExistingDigits: false,
      digits: "526",
      startIndex: 2,
    });
  });

  it("truncates partial multi-digit input to the available inputs", () => {
    expect(getEmailCodeDigitUpdate(4, "526")).toEqual({
      clearExistingDigits: false,
      digits: "52",
      startIndex: 4,
    });
  });

  it("ignores input without digits", () => {
    expect(getEmailCodeDigitUpdate(1, "abc")).toBeNull();
  });
});
