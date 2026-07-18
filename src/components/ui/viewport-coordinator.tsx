"use client";

import { useEffect } from "react";

const VIEWPORT_CENTER_PROPERTY = "--wallie-visual-viewport-center";
const VIEWPORT_HEIGHT_PROPERTY = "--wallie-visual-viewport-height";
const FOCUS_GUTTER = 16;

function isTextEntryControl(element: Element | null): element is HTMLElement {
  return (
    element instanceof HTMLElement &&
    (element.matches(
      "input:not([type='checkbox']):not([type='radio']), textarea, [contenteditable='true']",
    ) ||
      element.getAttribute("role") === "textbox")
  );
}

function describedElements(element: HTMLElement) {
  return (element.getAttribute("aria-describedby") ?? "")
    .split(/\s+/u)
    .filter(Boolean)
    .map((id) => document.getElementById(id))
    .filter((candidate): candidate is HTMLElement => candidate !== null);
}

function verticalScrollContainer(element: HTMLElement) {
  let ancestor = element.parentElement;
  while (ancestor && ancestor !== document.body) {
    const overflowY = window.getComputedStyle(ancestor).overflowY;
    if (/(auto|scroll)/u.test(overflowY) && ancestor.scrollHeight > ancestor.clientHeight) {
      return ancestor;
    }
    ancestor = ancestor.parentElement;
  }
  return null;
}

function keepFocusedContentVisible(viewport: VisualViewport) {
  const focused = document.activeElement;
  if (!isTextEntryControl(focused)) return;

  const rects = [focused, ...describedElements(focused)].map((element) =>
    element.getBoundingClientRect(),
  );
  const contentTop = Math.min(...rects.map((rect) => rect.top));
  const contentBottom = Math.max(...rects.map((rect) => rect.bottom));
  const stickyHeaderBottom =
    document.querySelector<HTMLElement>("[data-shell-header]")?.getBoundingClientRect().bottom ?? 0;
  const scrollContainer = verticalScrollContainer(focused);
  const scrollContainerRect = scrollContainer?.getBoundingClientRect();
  const visibleTop = Math.max(
    viewport.offsetTop + FOCUS_GUTTER,
    stickyHeaderBottom + FOCUS_GUTTER,
    (scrollContainerRect?.top ?? 0) + FOCUS_GUTTER,
  );
  const visibleBottom = Math.min(
    viewport.offsetTop + viewport.height - FOCUS_GUTTER,
    (scrollContainerRect?.bottom ?? Number.POSITIVE_INFINITY) - FOCUS_GUTTER,
  );
  const scrollTarget = scrollContainer ?? window;

  if (contentBottom > visibleBottom) {
    scrollTarget.scrollBy({ behavior: "instant", top: contentBottom - visibleBottom });
  } else if (contentTop < visibleTop) {
    scrollTarget.scrollBy({ behavior: "instant", top: contentTop - visibleTop });
  }
}

export function ViewportCoordinator() {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const activeViewport: VisualViewport = viewport;

    let frame = 0;
    function syncViewport() {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const root = document.documentElement;
        root.style.setProperty(
          VIEWPORT_CENTER_PROPERTY,
          `${activeViewport.offsetTop + activeViewport.height / 2}px`,
        );
        root.style.setProperty(VIEWPORT_HEIGHT_PROPERTY, `${activeViewport.height}px`);
        keepFocusedContentVisible(activeViewport);
      });
    }

    syncViewport();
    const validationObserver = new MutationObserver((records) => {
      if (
        isTextEntryControl(document.activeElement) &&
        records.some(
          (record) =>
            record.type === "characterData" ||
            [...record.addedNodes].some(
              (node) =>
                node instanceof HTMLElement &&
                (node.matches("[role='alert'], [role='status']") ||
                  node.querySelector("[role='alert'], [role='status']")),
            ),
        )
      ) {
        syncViewport();
      }
    });
    validationObserver.observe(document.body, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    activeViewport.addEventListener("resize", syncViewport);
    activeViewport.addEventListener("scroll", syncViewport);

    return () => {
      window.cancelAnimationFrame(frame);
      validationObserver.disconnect();
      activeViewport.removeEventListener("resize", syncViewport);
      activeViewport.removeEventListener("scroll", syncViewport);
      document.documentElement.style.removeProperty(VIEWPORT_CENTER_PROPERTY);
      document.documentElement.style.removeProperty(VIEWPORT_HEIGHT_PROPERTY);
    };
  }, []);

  return null;
}
