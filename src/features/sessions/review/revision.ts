import {
  LEADING_ACCEPTED_SCOPE_DIRECTIVE,
  specificationScopeMarkdownToPlainText,
} from "@/lib/sessions/specification-contracts";

import type { ArtifactSourceAnchor } from "./source-anchor";

export type AnchorMapping =
  | { status: "mapped"; anchor: ArtifactSourceAnchor }
  | { status: "outdated"; reason: string };

export type RevisionDiff = { kind: "unchanged" | "removed" | "added"; text: string };

type RevisionComparison = {
  kind: "line_diff" | "complete_sources";
  rows: RevisionDiff[];
};

/** Exact source line comparison; no HTML, newline or Unicode normalization.
 * Bound quadratic work; large revisions fall back to complete before/after.
 */
export function compareRevisionSources(before: string, after: string): RevisionComparison {
  if (before === after) return { kind: "line_diff", rows: [{ kind: "unchanged", text: before }] };
  const left = before.match(/[^\n]*(?:\n|$)/gu)?.filter(Boolean) ?? [];
  const right = after.match(/[^\n]*(?:\n|$)/gu)?.filter(Boolean) ?? [];
  if ((left.length + 1) * (right.length + 1) > 250000)
    return {
      kind: "complete_sources",
      rows: [
        { kind: "removed", text: before },
        { kind: "added", text: after },
      ],
    };
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
  return { kind: "line_diff", rows: result };
}

type RevisionBriefChange = { kind: "changed" | "added" | "removed"; excerpt: string };

export function summarizeRevisionChanges(rows: readonly RevisionDiff[]) {
  const changes: RevisionBriefChange[] = [];
  let count = 0;
  let added = "";
  let removed = "";
  const beforeSource = { first: true, acceptedScope: false };
  const afterSource = { first: true, acceptedScope: false };

  function briefText(text: string, source: typeof beforeSource) {
    if (source.first) {
      source.first = false;
      source.acceptedScope = LEADING_ACCEPTED_SCOPE_DIRECTIVE.test(text);
      if (source.acceptedScope) text = text.replace(LEADING_ACCEPTED_SCOPE_DIRECTIVE, "");
    }
    return source.acceptedScope ? specificationScopeMarkdownToPlainText(text) : text;
  }

  function finishChange() {
    if (!added && !removed) return;
    count += 1;
    if (changes.length < 3) {
      const text = (added || removed).trim();
      const excerpt = text.match(/^[\s\S]{0,160}/u)?.[0] ?? "";
      changes.push({
        kind: added && removed ? "changed" : added ? "added" : "removed",
        excerpt: excerpt.length < text.length ? `${excerpt}…` : excerpt,
      });
    }
    added = "";
    removed = "";
  }

  // Review Brief presents the human-facing Markdown. Source comparisons and
  // selection anchors retain the complete artifact, including the receipt line.
  for (const row of rows) {
    if (row.kind === "added") {
      added += briefText(row.text, afterSource);
    } else if (row.kind === "removed") {
      removed += briefText(row.text, beforeSource);
    } else {
      briefText(row.text, beforeSource);
      briefText(row.text, afterSource);
      finishChange();
    }
  }
  finishChange();

  return { changes, remaining: count - changes.length };
}
