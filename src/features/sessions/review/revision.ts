import { artifactSourceBlocks } from "./selection";
import {
  createArtifactSourceAnchor,
  validateArtifactSourceAnchor,
  type ArtifactSourceAnchor,
} from "./source-anchor";

export type AnchorMapping =
  | { status: "mapped"; anchor: ArtifactSourceAnchor }
  | { status: "outdated"; reason: string };

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
  const blocks = artifactSourceBlocks(source);
  if (blocks.some(({ anchor: value }) => value.end - value.start === 10000))
    return outdated("Large source blocks cannot be mapped safely.");
  const block = blocks.find(
    ({ anchor: value }) => value.start <= anchor.start && value.end >= anchor.end,
  );
  // Large blocks are split by the keyboard picker. They cannot prove that an
  // enclosing code fence is unchanged, so conservatively leave them outdated.
  if (!block || block.anchor.end - block.anchor.start === 10000)
    return outdated("The original block cannot be mapped safely.");
  const blockOffset = uniqueOffset(target, block.anchor.quote);
  if (blockOffset === null) return outdated("The original paragraph or code block changed.");
  const start = Array.from(target.slice(0, blockOffset)).length + anchor.start - block.anchor.start;
  return {
    status: "mapped",
    anchor: createArtifactSourceAnchor(target, start, start + anchor.end - anchor.start),
  };
}

export type RevisionDiff = { kind: "unchanged" | "removed" | "added"; text: string };

/** Exact source line comparison; no HTML, newline or Unicode normalization.
 * Bound quadratic work; large revisions fall back to complete before/after.
 */
export function compareRevisionSources(before: string, after: string): RevisionDiff[] {
  if (before === after) return [{ kind: "unchanged", text: before }];
  const left = before.match(/[^\n]*(?:\n|$)/gu)?.filter(Boolean) ?? [];
  const right = after.match(/[^\n]*(?:\n|$)/gu)?.filter(Boolean) ?? [];
  if ((left.length + 1) * (right.length + 1) > 250000)
    return [
      { kind: "removed", text: before },
      { kind: "added", text: after },
    ];
  const matrix = Array.from({ length: left.length + 1 }, () => new Uint32Array(right.length + 1));
  for (let i = left.length - 1; i >= 0; i--)
    for (let j = right.length - 1; j >= 0; j--)
      matrix[i]![j] =
        left[i] === right[j]
          ? matrix[i + 1]![j + 1]! + 1
          : Math.max(matrix[i + 1]![j]!, matrix[i]![j + 1]!);
  const result: RevisionDiff[] = [];
  const append = (kind: RevisionDiff["kind"], text: string) => {
    if (result.at(-1)?.kind === kind) result[result.length - 1]!.text += text;
    else result.push({ kind, text });
  };
  let i = 0,
    j = 0;
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) {
      append("unchanged", left[i++]!);
      j++;
    } else if (i < left.length && (j === right.length || matrix[i + 1]![j]! >= matrix[i]![j + 1]!))
      append("removed", left[i++]!);
    else append("added", right[j++]!);
  }
  return result;
}
