import type { ArtifactSourceAnchor } from "./source-anchor";

export type AnchorMapping =
  | { status: "mapped"; anchor: ArtifactSourceAnchor }
  | { status: "outdated"; reason: string };

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
