import { describe, expect, it } from "vitest";

import {
  createArtifactSourceAnchor,
  validateArtifactSourceAnchor,
} from "@/features/sessions/review/source-anchor";

describe("artifact source anchors", () => {
  it("counts astral characters as one code point and preserves combining characters", () => {
    const source = "A😀e\u0301界Z";
    const anchor = createArtifactSourceAnchor(source, 1, 5);

    expect(anchor).toEqual({
      coordinateSystem: "unicode_code_points",
      start: 1,
      end: 5,
      quote: "😀e\u0301界",
      prefix: "A",
      suffix: "Z",
    });
    expect(validateArtifactSourceAnchor(source, anchor)).toBe(true);
    expect(validateArtifactSourceAnchor(source.normalize("NFC"), anchor)).toBe(false);
  });

  it("anchors Markdown syntax and code fences in the source rather than rendered text", () => {
    const source = '# Plan\n\n```ts\nconst title = "😀";\n```\n\n**Ship** it.';
    const start = Array.from(source.slice(0, source.indexOf("```ts"))).length;
    const quote = '```ts\nconst title = "😀";\n```';
    const anchor = createArtifactSourceAnchor(source, start, start + Array.from(quote).length);

    expect(anchor.quote).toBe(quote);
    expect(anchor.prefix).toBe("# Plan\n\n");
    expect(anchor.suffix).toBe("\n\n**Ship** it.");
    expect(validateArtifactSourceAnchor(source, anchor)).toBe(true);
  });

  it("uses offsets and surrounding context to distinguish repeated text", () => {
    const source = "first: revise\nsecond: revise\nthird: revise";
    const start = source.indexOf("revise", source.indexOf("second:"));
    const anchor = createArtifactSourceAnchor(source, start, start + 6);

    expect(anchor.quote).toBe("revise");
    expect(validateArtifactSourceAnchor(source, anchor)).toBe(true);
    expect(validateArtifactSourceAnchor(source, { ...anchor, start: 7, end: 13 })).toBe(false);
    expect(validateArtifactSourceAnchor(source, { ...anchor, prefix: "third: " })).toBe(false);
    expect(validateArtifactSourceAnchor(source, { ...anchor, suffix: "\nfirst:" })).toBe(false);
  });

  it("preserves CRLF and counts each line-ending code point", () => {
    const source = "one\r\n😀two\r\nthree";
    const anchor = createArtifactSourceAnchor(source, 3, 11);

    expect(anchor.quote).toBe("\r\n😀two\r\n");
    expect(anchor.prefix).toBe("one");
    expect(anchor.suffix).toBe("three");
    expect(validateArtifactSourceAnchor(source, anchor)).toBe(true);
    expect(validateArtifactSourceAnchor(source.replaceAll("\r\n", "\n"), anchor)).toBe(false);
  });

  it("bounds generated context without splitting astral code points", () => {
    const source = `${"😀".repeat(40)}selected${"界".repeat(40)}`;
    const anchor = createArtifactSourceAnchor(source, 40, 48);

    expect(anchor.prefix).toBe("😀".repeat(32));
    expect(anchor.suffix).toBe("界".repeat(32));
    expect(validateArtifactSourceAnchor(source, anchor)).toBe(true);
  });

  it("permits a whole-source selection and empty boundary context", () => {
    const anchor = createArtifactSourceAnchor("😀", 0, 1);

    expect(anchor).toMatchObject({ quote: "😀", prefix: "", suffix: "" });
    expect(validateArtifactSourceAnchor("😀", anchor)).toBe(true);
  });

  it("limits the selected quote to 10000 code points rather than UTF-16 code units", () => {
    const source = "😀".repeat(10_001);
    const anchor = createArtifactSourceAnchor(source, 0, 10_000);

    expect(Array.from(anchor.quote)).toHaveLength(10_000);
    expect(validateArtifactSourceAnchor(source, anchor)).toBe(true);
    expect(() => createArtifactSourceAnchor(source, 0, 10_001)).toThrow(RangeError);
    expect(
      validateArtifactSourceAnchor(source, { ...anchor, end: 10_001, quote: source, suffix: "" }),
    ).toBe(false);
  });

  it("requires 32 code points of context on each side when available", () => {
    const source = `${"😀".repeat(130)}X${"界".repeat(130)}`;
    const anchor = createArtifactSourceAnchor(source, 130, 131);

    expect(validateArtifactSourceAnchor(source, { ...anchor, prefix: "😀".repeat(31) })).toBe(
      false,
    );
    expect(validateArtifactSourceAnchor(source, { ...anchor, suffix: "界".repeat(31) })).toBe(
      false,
    );
    expect(
      validateArtifactSourceAnchor(source, {
        ...anchor,
        prefix: "😀".repeat(128),
        suffix: "界".repeat(128),
      }),
    ).toBe(true);
    expect(validateArtifactSourceAnchor(source, { ...anchor, prefix: "😀".repeat(129) })).toBe(
      false,
    );
    expect(validateArtifactSourceAnchor(source, { ...anchor, suffix: "界".repeat(129) })).toBe(
      false,
    );
  });

  it("requires all available context when there are fewer than 32 code points", () => {
    const source = "before X after";
    const anchor = createArtifactSourceAnchor(source, 7, 8);

    expect(validateArtifactSourceAnchor(source, anchor)).toBe(true);
    expect(validateArtifactSourceAnchor(source, { ...anchor, prefix: " " })).toBe(false);
    expect(validateArtifactSourceAnchor(source, { ...anchor, suffix: " " })).toBe(false);
  });

  it.each(["\ud800", "\udfff", "before\ud800after", "😀\udc00"])(
    "rejects lone surrogates in source: %j",
    (source) => {
      expect(() => createArtifactSourceAnchor(source, 0, 1)).toThrow(RangeError);
      expect(
        validateArtifactSourceAnchor(source, {
          coordinateSystem: "unicode_code_points",
          start: 0,
          end: Array.from(source).length,
          quote: source,
          prefix: "",
          suffix: "",
        }),
      ).toBe(false);
    },
  );

  it("rejects lone surrogates in a supplied quote or context", () => {
    const source = "before X after";
    const anchor = createArtifactSourceAnchor(source, 7, 8);

    expect(validateArtifactSourceAnchor(source, { ...anchor, quote: "\ud800" })).toBe(false);
    expect(validateArtifactSourceAnchor(source, { ...anchor, prefix: "\ud800" })).toBe(false);
    expect(validateArtifactSourceAnchor(source, { ...anchor, suffix: "\udfff" })).toBe(false);
  });

  it.each([
    [-1, 2],
    [0, 0],
    [2, 1],
    [0.5, 2],
    [0, 1.5],
    [0, 4],
    [NaN, 2],
    [0, Infinity],
    [0, Number.MAX_SAFE_INTEGER + 1],
  ])("rejects invalid source ranges (%s, %s)", (start, end) => {
    expect(() => createArtifactSourceAnchor("abc", start, end)).toThrow(RangeError);
    const anchor = createArtifactSourceAnchor("abc", 0, 1);
    expect(validateArtifactSourceAnchor("abc", { ...anchor, start, end })).toBe(false);
  });

  it.each([
    null,
    undefined,
    "anchor",
    {},
    { coordinateSystem: "utf16", start: 0, end: 1, quote: "a", prefix: "", suffix: "bc" },
    {
      coordinateSystem: "unicode_code_points",
      start: "0",
      end: 1,
      quote: "a",
      prefix: "",
      suffix: "bc",
    },
    { coordinateSystem: "unicode_code_points", start: 0, end: 1, quote: "a", prefix: "" },
  ])("rejects malformed external anchors: %j", (anchor) => {
    expect(validateArtifactSourceAnchor("abc", anchor)).toBe(false);
  });

  it("rejects a quote that does not match the selected source range", () => {
    const anchor = createArtifactSourceAnchor("Ship safely", 0, 4);

    expect(validateArtifactSourceAnchor("Ship safely", { ...anchor, quote: "Skip" })).toBe(false);
    expect(validateArtifactSourceAnchor("", anchor)).toBe(false);
  });
});
