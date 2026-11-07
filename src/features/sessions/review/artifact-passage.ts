import type { ArtifactSourceAnchor } from "./source-anchor";

export function indexArtifactText(reader: HTMLElement) {
  return Array.from(
    reader.querySelectorAll<HTMLElement>("[data-review-text-start], [data-review-rendered-start]"),
  )
    .flatMap((element) => {
      const exact = element.dataset.reviewTextStart !== undefined;
      const start = Number(element.dataset.reviewTextStart ?? element.dataset.reviewRenderedStart);
      const end = Number(element.dataset.reviewTextEnd ?? element.dataset.reviewRenderedEnd);
      const node = element.firstChild;
      if (!(node instanceof Text) || node !== element.lastChild || !(start < end)) return [];
      return [{ start, end, node, exact }];
    })
    .sort((a, b) => a.start - b.start);
}

export function artifactPassageRanges(
  text: ReturnType<typeof indexArtifactText>,
  anchor: Pick<ArtifactSourceAnchor, "start" | "end">,
): Range[] {
  const ranges: Range[] = [];
  for (const { start, end, node, exact } of text) {
    if (end <= anchor.start) continue;
    if (start >= anchor.end) break;
    const from = Math.max(start, anchor.start);
    const to = Math.min(end, anchor.end);
    const range = node.ownerDocument.createRange();
    if (from === start && to === end) {
      range.selectNodeContents(node);
    } else if (exact) {
      const points = Array.from(node.data);
      if (points.length !== end - start) return [];
      range.setStart(node, points.slice(0, from - start).join("").length);
      range.setEnd(node, points.slice(0, to - start).join("").length);
    } else {
      // A partial selection of transformed Markdown must be shown in Raw.
      return [];
    }
    ranges.push(range);
  }
  return ranges;
}

export function firstPassageRect(ranges: Range[]): DOMRect | undefined {
  for (const range of ranges) {
    const rect = Array.from(range.getClientRects?.() ?? []).find(({ height }) => height > 0);
    if (rect) return rect;
  }
}

export function artifactPassageRects(reader: HTMLElement, ranges: Range[]) {
  const bounds = reader.getBoundingClientRect();
  return ranges.flatMap((range) => {
    let { left, right, top, bottom } = bounds;
    for (
      let node = range.startContainer.parentElement;
      node && node !== reader;
      node = node.parentElement
    ) {
      const { overflowX, overflowY } = getComputedStyle(node);
      const clip = /auto|scroll|hidden|clip/u;
      if (!clip.test(overflowX) && !clip.test(overflowY)) continue;
      const rect = node.getBoundingClientRect();
      if (clip.test(overflowX)) {
        left = Math.max(left, rect.left);
        right = Math.min(right, rect.right);
      }
      if (clip.test(overflowY)) {
        top = Math.max(top, rect.top);
        bottom = Math.min(bottom, rect.bottom);
      }
    }
    return Array.from(range.getClientRects?.() ?? []).flatMap((rect) => {
      const x = Math.max(left, rect.left);
      const y = Math.max(top, rect.top);
      const width = Math.min(right, rect.right) - x;
      const height = Math.min(bottom, rect.bottom) - y;
      return width > 0 && height > 0
        ? [{ left: x - bounds.left, top: y - bounds.top, width, height }]
        : [];
    });
  });
}

export function revealArtifactPassage(range: Range, panel: HTMLElement | null) {
  for (let node = range.startContainer.parentElement; node; node = node.parentElement) {
    if (
      node.scrollWidth <= node.clientWidth ||
      !/auto|scroll/u.test(getComputedStyle(node).overflowX)
    )
      continue;
    const rect = firstPassageRect([range]);
    if (!rect) return;
    const bounds = node.getBoundingClientRect();
    if (rect.left < bounds.left || rect.left >= bounds.right) {
      node.scrollBy({ left: rect.left - bounds.left - 12, behavior: "instant" });
    }
  }
  const rect = firstPassageRect([range]);
  if (!rect) return;
  const viewport = window.visualViewport;
  const top = Math.max(
    viewport?.offsetTop ?? 0,
    document.querySelector("[data-shell-header]")?.getBoundingClientRect().bottom ?? 0,
  );
  const panelStyle = panel && getComputedStyle(panel);
  const bottom =
    panelStyle?.position === "fixed" && panel
      ? panel.getBoundingClientRect().top
      : (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight);
  const offset = Math.max(12, Math.min(112, (bottom - top - rect.height) / 3));
  let scroll = rect.top - top - offset;
  if (panelStyle?.position === "sticky" && panel?.parentElement) {
    const workspace = panel.parentElement.getBoundingClientRect();
    const maxHeight = Number.parseFloat(panelStyle.maxHeight);
    const stickyTop = Number.parseFloat(panelStyle.top);
    if (Number.isFinite(maxHeight) && Number.isFinite(stickyTop)) {
      scroll = Math.min(
        scroll,
        workspace.bottom - stickyTop - Math.min(maxHeight, workspace.height),
      );
    }
  }
  window.scrollBy({ top: scroll, behavior: "instant" });
}
