import { describe, expect, it } from "vitest";
import { createArtifactSourceAnchor } from "./source-anchor";
import { compareRevisionSources } from "./revision";
import { mapRevisionAnchor } from "./revision-anchor.server";

describe("conservative revision anchors", () => {
  it("maps a moved unique unchanged paragraph using code points", () => {
    const source = "😀 intro\n\nUnique paragraph.\n\nEnd.";
    const start = Array.from(source.slice(0, source.indexOf("Unique"))).length;
    const result = mapRevisionAnchor(
      source,
      "New\n\n" + source,
      createArtifactSourceAnchor(source, start, start + 6),
    );
    expect(result.status).toBe("mapped");
    if (result.status === "mapped") expect(result.anchor.start).toBe(start + 5);
  });
  it.each([
    ["repeat\n\nrepeat\n", "repeat\n", "repeat"],
    ["unique\n", "unique\n\nunique\n", "unique"],
    ["repeat\n\nrepeat\n", "New\n\nrepeat\n\nrepeat\n", "repeat\n\n"],
    ["deleted paragraph\n", "other paragraph\n", "deleted"],
    ["```js\nkeep()\nold()\n```\n", "```js\nkeep()\nnew()\n```\n", "keep()"],
    ["```js\nkeep()\n\nold()\n```\n", "```js\nkeep()\n\nnew()\n```\n", "keep()"],
    ["café\r\n", "café\n", "café"],
    ["Unique paragraph.\n\n", "```text\nUnique paragraph.\n\n```\n", "Unique paragraph."],
    ["Unique paragraph.\n\n", "Larger Unique paragraph.\n\n", "Unique paragraph."],
    ["Unique paragraph.\n\n", "<pre>\n\nUnique paragraph.\n\n</pre>\n", "Unique paragraph."],
  ])("leaves uncertain selections outdated", (source, target, quote) => {
    const start = Array.from(source.slice(0, source.indexOf(quote))).length;
    expect(
      mapRevisionAnchor(
        source,
        target,
        createArtifactSourceAnchor(source, start, start + Array.from(quote).length),
      ).status,
    ).toBe("outdated");
  });
  it("keeps unchanged repeated text at its original verified coordinates", () => {
    const source = "same same";
    expect(
      mapRevisionAnchor(source, source, createArtifactSourceAnchor(source, 5, 9)),
    ).toMatchObject({ status: "mapped", anchor: { start: 5 } });
    expect(mapRevisionAnchor(source, source, { start: 0 })).toMatchObject({ status: "outdated" });
  });
});

describe("exact source diff", () => {
  it.each([
    ["one\r\ntwo\n", "one\nthree\n"],
    ["", "😀"],
    ["same", "same"],
    ["a\n".repeat(600), "b\n".repeat(600)],
  ])("reconstructs both source strings", (before, after) => {
    const { rows: diff } = compareRevisionSources(before, after);
    expect(
      diff
        .filter((row) => row.kind !== "added")
        .map((row) => row.text)
        .join(""),
    ).toBe(before);
    expect(
      diff
        .filter((row) => row.kind !== "removed")
        .map((row) => row.text)
        .join(""),
    ).toBe(after);
  });
});
