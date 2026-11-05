import { createArtifactSourceAnchor, type ArtifactSourceAnchor } from "./source-anchor";

/** Map a DOM boundary to a server-annotated exact source text node. */
function sourcePoint(root: HTMLElement, node: Node, offset: number): number | null {
  const element = node.nodeType === 1 ? (node as Element) : node.parentElement;
  const span = element?.closest<HTMLElement>("[data-review-text-start]");
  if (!span || !root.contains(span)) return null;
  const start = Number(span.dataset.reviewTextStart);
  const end = Number(span.dataset.reviewTextEnd);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null;
  const range = document.createRange();
  range.selectNodeContents(span);
  try {
    range.setEnd(node, offset);
  } catch {
    return null;
  }
  const prefix = range.toString();
  const lastUnit = prefix.charCodeAt(prefix.length - 1);
  // A UTF-16 DOM offset may split an astral character. Never round it silently.
  if (lastUnit >= 0xd800 && lastUnit <= 0xdbff) return null;
  const position = start + Array.from(prefix).length;
  return position <= end ? position : null;
}

export function selectedArtifactSourceAnchor(
  root: HTMLElement,
  source: string,
  selection: Selection | null = window.getSelection(),
): ArtifactSourceAnchor | null {
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null;
  const range = selection.getRangeAt(0);
  const start = sourcePoint(root, range.startContainer, range.startOffset);
  const end = sourcePoint(root, range.endContainer, range.endOffset);
  if (start === null || end === null) return null;
  try {
    return createArtifactSourceAnchor(source, start, end);
  } catch {
    return null;
  }
}

export type ArtifactSourceBlock = { label: string; anchor: ArtifactSourceAnchor };

/** Keyboard fallback uses the original source, including fenced code and CRLF. */
export function artifactSourceBlocks(source: string): ArtifactSourceBlock[] {
  const points = Array.from(source);
  const blocks: ArtifactSourceBlock[] = [];
  let start = 0;
  let cursor = 0;
  let fence: string | null = null;
  function add(end: number) {
    // Bound even an unusually large paragraph/code block to the anchor contract.
    for (let at = start; at < end; at += 10000) {
      const finish = Math.min(end, at + 10000);
      const quote = points.slice(at, finish).join("");
      if (!quote.trim()) continue;
      blocks.push({
        label: `${blocks.length + 1}. ${quote.replace(/\s+/gu, " ").slice(0, 80)}`,
        anchor: {
          coordinateSystem: "unicode_code_points",
          start: at,
          end: finish,
          quote,
          prefix: points.slice(Math.max(0, at - 32), at).join(""),
          suffix: points.slice(finish, finish + 32).join(""),
        },
      });
    }
    start = end;
  }
  for (const line of source.match(/[^\n]*(?:\n|$)/gu) ?? []) {
    if (!line) continue;
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/u)?.[1];
    const wasFenced = fence !== null;
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
    }
    cursor += Array.from(line).length;
    if (!wasFenced && !fence && !line.trim()) add(cursor);
  }
  add(points.length);
  return blocks;
}
