import { createArtifactSourceAnchor, type ArtifactSourceAnchor } from "./source-anchor";

/** Resolve element boundaries produced by select-all, triple-click and keyboard selection. */
function textBoundary(node: Node, offset: number, edge: "start" | "end") {
  if (node.nodeType === Node.TEXT_NODE) return { node, offset };
  if (offset < 0 || offset > node.childNodes.length) return null;
  const before = edge === "end" ? offset > 0 : offset === node.childNodes.length;
  let child = node.childNodes[before ? offset - 1 : offset];
  if (!child) return null;
  while (child.childNodes.length) {
    child = (before ? child.lastChild : child.firstChild)!;
  }
  return child.nodeType === Node.TEXT_NODE
    ? { node: child, offset: before ? child.textContent!.length : 0 }
    : null;
}

/** Map a DOM boundary to a server-annotated exact source text node. */
function sourcePoint(
  root: HTMLElement,
  boundaryNode: Node,
  boundaryOffset: number,
  edge: "start" | "end",
): number | null {
  if (!root.contains(boundaryNode)) return null;
  const boundary = textBoundary(boundaryNode, boundaryOffset, edge);
  if (!boundary) return null;
  const { node, offset } = boundary;
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
  const start = sourcePoint(root, range.startContainer, range.startOffset, "start");
  const end = sourcePoint(root, range.endContainer, range.endOffset, "end");
  if (start === null || end === null) return null;
  try {
    return createArtifactSourceAnchor(source, start, end);
  } catch {
    return null;
  }
}
