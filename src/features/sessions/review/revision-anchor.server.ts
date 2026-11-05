import "server-only";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { unified } from "unified";
import { createArtifactSourceAnchor, validateArtifactSourceAnchor } from "./source-anchor";
import type { AnchorMapping } from "./revision";

// Use the same Markdown grammar as the rendered artifact. Root blocks include
// their exact following separators; nested selections require their enclosing
// list, quote, code or HTML block to remain unchanged too.
function markdownBlocks(source: string) {
  const nodes = unified().use(remarkParse).use(remarkGfm).parse(source).children;
  const result: Array<{ type: string; anchor: { start: number; end: number; quote: string } }> = [];
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index]!;
    const start = node.position?.start.offset;
    const end = index + 1 < nodes.length ? nodes[index + 1]?.position?.start.offset : source.length;
    if (typeof start !== "number" || typeof end !== "number") return null;
    result.push({
      type: node.type,
      anchor: {
        start: Array.from(source.slice(0, start)).length,
        end: Array.from(source.slice(0, end)).length,
        quote: source.slice(start, end),
      },
    });
  }
  return result;
}

function uniqueOffset(source: string, quote: string): number | null {
  const first = source.indexOf(quote);
  return first >= 0 && source.indexOf(quote, first + 1) < 0 ? first : null;
}

/** Derived presentation only. Never rewrite the original anchor or thread status.
 * Require both a unique quote and an unchanged enclosing source block. In
 * particular an unchanged token inside an edited code fence is not a match.
 */
export function mapRevisionAnchor(source: string, target: string, anchor: unknown): AnchorMapping {
  const outdated = (reason: string): AnchorMapping => ({ status: "outdated", reason });
  if (!validateArtifactSourceAnchor(source, anchor))
    return outdated("Original source is unavailable or invalid.");
  if (source === target) return { status: "mapped", anchor };
  // A keyboard paragraph anchor may include different trailing blank lines.
  // Those delimiters must not disambiguate otherwise repeated visible text.
  const salientQuote = anchor.quote.trim();
  if (
    !salientQuote ||
    uniqueOffset(source, salientQuote) === null ||
    uniqueOffset(target, salientQuote) === null
  )
    return outdated("Selected text was deleted, edited or repeated.");
  if (uniqueOffset(source, anchor.quote) === null || uniqueOffset(target, anchor.quote) === null)
    return outdated("Selected text was deleted, edited or repeated.");
  const blocks = markdownBlocks(source);
  if (!blocks) return outdated("Source Markdown block positions are unavailable.");
  if (blocks.some(({ anchor: value }) => value.end - value.start >= 10000))
    return outdated("Large source blocks cannot be mapped safely.");
  const block = blocks.find(
    ({ anchor: value }) => value.start <= anchor.start && value.end >= anchor.end,
  );
  // Large blocks are split by the keyboard picker. They cannot prove that an
  // enclosing code fence is unchanged, so conservatively leave them outdated.
  if (!block || block.anchor.end - block.anchor.start === 10000)
    return outdated("The original block cannot be mapped safely.");
  const targetBlocks = markdownBlocks(target);
  if (!targetBlocks) return outdated("Target Markdown block positions are unavailable.");
  if (targetBlocks.some(({ anchor: value }) => value.end - value.start >= 10000))
    return outdated("Large target blocks cannot be mapped safely.");
  const matches = targetBlocks.filter(
    (candidate) => candidate.type === block.type && candidate.anchor.quote === block.anchor.quote,
  );
  if (matches.length !== 1) return outdated("The enclosing paragraph or code block changed.");
  const start = matches[0]!.anchor.start + anchor.start - block.anchor.start;
  return {
    status: "mapped",
    anchor: createArtifactSourceAnchor(target, start, start + anchor.end - anchor.start),
  };
}
