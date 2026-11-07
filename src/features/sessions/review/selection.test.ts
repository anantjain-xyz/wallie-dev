// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";

import { renderMarkdownToHtml } from "@/components/shared/markdown-content.server";
import { artifactPassageRanges, indexArtifactText } from "./artifact-passage";
import { artifactSourceBlocks, selectedArtifactSourceAnchor } from "./selection";
import { createArtifactSourceAnchor, validateArtifactSourceAnchor } from "./source-anchor";

beforeEach(() => {
  document.body.innerHTML = "";
  window.getSelection()?.removeAllRanges();
});
function select(source: string, text: string, occurrence = 0, from = 0, to = text.length) {
  document.body.innerHTML = renderMarkdownToHtml(source, true);
  const root = document.body.firstElementChild as HTMLElement;
  const span = [...root.querySelectorAll("[data-review-text-start]")].filter(
    (node) => node.textContent === text,
  )[occurrence]!;
  const range = document.createRange();
  range.setStart(span.firstChild!, from);
  range.setEnd(span.firstChild!, to);
  window.getSelection()!.addRange(range);
  return selectedArtifactSourceAnchor(root, source);
}

describe("rendered artifact source selection", () => {
  it("uses exact code point positions for repeated text with astral and combining characters", () => {
    const source = "# 🚀\n\nRepeat café é\n\nRepeat café é";
    const anchor = select(source, "Repeat café é", 1, 7, 13)!;
    expect(anchor.quote).toBe("café e");
    expect(anchor.start).toBe(Array.from(source.slice(0, source.lastIndexOf("café"))).length);
    expect(validateArtifactSourceAnchor(source, anchor)).toBe(true);
  });
  it("maps text inside formatting without guessing from matching text", () => {
    expect(select("A **retry** then retry", "retry")?.quote).toBe("retry");
  });
  it("reopens the second exact selection after an astral character", () => {
    const source = "Repeat 🚀 café\n\nRepeat 🚀 café";
    const anchor = select(source, "Repeat 🚀 café", 1, 10, 14)!;
    const text = indexArtifactText(document.body);
    const ranges = artifactPassageRanges(text, anchor);
    expect(ranges.map((range) => range.toString())).toEqual(["café"]);
    expect(ranges[0]?.startContainer).toBe(text[1]?.node);
  });
  it("projects a whole transformed block and leaves partial source syntax for Raw", () => {
    const source = "café &amp; tea";
    document.body.innerHTML = renderMarkdownToHtml(source, true);
    const text = indexArtifactText(document.body);
    const [block] = artifactSourceBlocks(source);
    expect(artifactPassageRanges(text, block!.anchor).map((range) => range.toString())).toEqual([
      "café & tea",
    ]);
    const rawAnchor = createArtifactSourceAnchor(source, 5, 10);
    expect(artifactPassageRanges(text, rawAnchor)).toEqual([]);

    const raw = document.createElement("pre");
    raw.dataset.reviewTextStart = "0";
    raw.dataset.reviewTextEnd = String(source.length);
    raw.textContent = source;
    document.body.replaceChildren(raw);
    expect(artifactPassageRanges(indexArtifactText(document.body), rawAnchor)[0]?.toString()).toBe(
      "&amp;",
    );
  });
  it("maps an exact code block", () => {
    const source = "```ts\nconst rocket = '🚀';\n```";
    expect(select(source, "const rocket = '🚀';\n", 0, 6, 12)?.quote).toBe("rocket");
  });
  it("does not invent coordinates for decoded entities", () => {
    document.body.innerHTML = renderMarkdownToHtml("café &amp; tea", true);
    expect(document.querySelector("[data-review-text-start]")).toBeNull();
  });
  it("rejects a UTF-16 boundary inside an astral character", () => {
    expect(select("A🚀B", "A🚀B", 0, 1, 2)).toBeNull();
  });
  it("rejects a selection outside the reader", () => {
    select("hello", "hello");
    expect(selectedArtifactSourceAnchor(document.createElement("div"), "hello")).toBeNull();
  });
  it("cannot accept source-coordinate attributes from untrusted Markdown", () => {
    const html = renderMarkdownToHtml(
      '<span data-review-text-start="0" onclick="evil()">Fake</span>',
      true,
    );
    expect(html).not.toContain('data-review-text-start="0"');
    expect(html).not.toContain("onclick");
  });
});

describe("keyboard source blocks", () => {
  it("preserves CRLF and blank lines inside fenced code", () => {
    const source = "# Heading\r\n\r\n```ts\r\none\r\n\r\ntwo\r\n```\r\n\r\nLast";
    const blocks = artifactSourceBlocks(source);
    expect(blocks).toHaveLength(3);
    expect(blocks[1]!.anchor.quote).toContain("one\r\n\r\ntwo");
    expect(blocks.every((block) => validateArtifactSourceAnchor(source, block.anchor))).toBe(true);
  });
  it("splits a large code block into bounded valid anchors", () => {
    const source = "```\n" + "🚀".repeat(12000) + "\n```";
    const blocks = artifactSourceBlocks(source);
    expect(blocks).toHaveLength(2);
    expect(
      blocks.every(
        (block) =>
          Array.from(block.anchor.quote).length <= 10000 &&
          validateArtifactSourceAnchor(source, block.anchor),
      ),
    ).toBe(true);
  });
});
