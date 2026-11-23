import { describe, expect, it } from "vitest";
import { createArtifactSourceAnchor } from "./source-anchor";
import { compareRevisionSources, summarizeRevisionChanges } from "./revision";
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

describe("review brief", () => {
  const scopeDirective = "<!-- wallie-accepted-scope: eyJ2ZXJzaW9uIjoxfQ -->\n";
  const criteria = "## Acceptance criteria\n- Use UTC dates.";

  it("presents visible criteria without the scope directive and retains exact source rows", () => {
    const after = scopeDirective + criteria;
    const { rows } = compareRevisionSources("Pending scope.", after);
    expect(summarizeRevisionChanges(rows)).toEqual({
      changes: [{ kind: "changed", excerpt: criteria }],
      remaining: 0,
    });
    expect(
      rows
        .filter(({ kind }) => kind !== "removed")
        .map(({ text }) => text)
        .join(""),
    ).toBe(after);
  });

  it("keeps embedded directive-looking text and ignores a leading scope-only change", () => {
    const metadataOnly = compareRevisionSources(
      scopeDirective + criteria,
      scopeDirective.replace("eyJ2ZXJzaW9uIjoxfQ", "dXBkYXRlZA") + criteria,
    );
    expect(summarizeRevisionChanges(metadataOnly.rows)).toEqual({ changes: [], remaining: 0 });
    const examples = compareRevisionSources("# Example\n", "# Example\n" + scopeDirective);
    expect(summarizeRevisionChanges(examples.rows).changes[0]?.excerpt).toBe(scopeDirective.trim());
  });

  it("shows literal scope punctuation in plain excerpts and keeps escapes in ordinary excerpts", () => {
    const escaped = "- Write \\&copy; and \\[UTC\\] in the report.";
    const ordinary = compareRevisionSources("Old draft", escaped);
    const scope = compareRevisionSources("Old draft", scopeDirective + escaped);
    expect(summarizeRevisionChanges(ordinary.rows).changes[0]?.excerpt).toBe(escaped);
    expect(summarizeRevisionChanges(scope.rows).changes[0]?.excerpt).toBe(
      "- Write &copy; and [UTC] in the report.",
    );
    expect(
      scope.rows
        .filter((row) => row.kind !== "removed")
        .map((row) => row.text)
        .join(""),
    ).toBe(scopeDirective + escaped);
  });
});
