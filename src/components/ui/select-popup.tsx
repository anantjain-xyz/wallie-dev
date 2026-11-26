"use client";

import {
  useLayoutEffect,
  useState,
  type ComponentPropsWithoutRef,
  type CSSProperties,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

import { useModalOverlayContainer, useOverlayContainer } from "@/components/ui/portal-root";
import { cn } from "@/lib/utils";

export const SELECT_FIT_CONTENT_CLASS =
  "w-max min-w-[max(12rem,var(--radix-select-trigger-width))] max-w-[min(24rem,var(--radix-select-content-available-width,100vw),calc(100vw-(var(--overlay-gutter-inline)*2)))]";

function isNonNoneCss(value: string) {
  return Boolean(value) && value !== "none";
}

/** Viewport offset when the portal target is a `position: fixed` containing block. */
function portalFixedContainingBlock(container: HTMLElement) {
  const style = getComputedStyle(container);
  const willChangeTokens = style.willChange.split(",").map((token) => token.trim());
  const createsContainingBlock =
    isNonNoneCss(style.transform) ||
    isNonNoneCss(style.filter) ||
    isNonNoneCss(style.perspective) ||
    style.contain === "paint" ||
    style.contain === "layout" ||
    style.contain === "strict" ||
    style.contain === "content" ||
    willChangeTokens.includes("transform") ||
    willChangeTokens.includes("filter") ||
    willChangeTokens.includes("perspective");

  if (!createsContainingBlock) {
    return { bottom: window.innerHeight, left: 0, right: window.innerWidth, top: 0 };
  }

  const rect = container.getBoundingClientRect();
  return { bottom: rect.bottom, left: rect.left, right: rect.right, top: rect.top };
}

export function scrollSelectOptionIntoView(listbox: HTMLElement, option: HTMLElement) {
  const top =
    option.getBoundingClientRect().top - listbox.getBoundingClientRect().top + listbox.scrollTop;
  const bottom = top + option.offsetHeight;
  if (top < listbox.scrollTop) listbox.scrollTop = top;
  else if (bottom > listbox.scrollTop + listbox.clientHeight)
    listbox.scrollTop = bottom - listbox.clientHeight;
}

export function SelectPopup({
  align = "start",
  anchor,
  className,
  container: containerOverride,
  open,
  ref,
  ...props
}: Omit<ComponentPropsWithoutRef<"div">, "style"> & {
  align?: "start" | "end";
  anchor: HTMLElement | null;
  container?: HTMLElement | null;
  open: boolean;
  ref: RefObject<HTMLDivElement | null>;
}) {
  const overlayContainer = useOverlayContainer();
  const modalContainer = useModalOverlayContainer();
  const container =
    containerOverride ??
    modalContainer ??
    anchor?.closest<HTMLElement>('[aria-modal="true"]') ??
    overlayContainer ??
    (typeof document !== "undefined" ? document.body : null);
  const [position, setPosition] = useState<CSSProperties>({});

  useLayoutEffect(() => {
    if (!open) return;
    const listbox = ref.current;
    if (!anchor || !listbox || !container) return;
    const scrollBoundary = anchor.closest<HTMLElement>("[data-select-scroll-boundary]");

    function place() {
      if (!anchor || !listbox || !container) return;
      const rect = anchor.getBoundingClientRect();
      const origin = portalFixedContainingBlock(container);
      const gutter = 8;
      const sideOffset = 6;
      const boundaryRect = scrollBoundary?.getBoundingClientRect();
      const viewport = boundaryRect ? window.visualViewport : null;
      const viewportTop = viewport?.offsetTop ?? 0;
      const viewportBottom = viewportTop + (viewport?.height ?? window.innerHeight);
      const boundaryTop = boundaryRect ? Math.max(boundaryRect.top, viewportTop) + gutter : gutter;
      const boundaryBottom = boundaryRect
        ? Math.min(boundaryRect.bottom, viewportBottom) - gutter
        : window.innerHeight - gutter;
      const boundaryHeight = Math.max(0, boundaryBottom - boundaryTop);
      const spaceBelow = boundaryBottom - rect.bottom - sideOffset;
      const spaceAbove = rect.top - sideOffset - boundaryTop;
      const placeAbove = spaceBelow < 160 && spaceAbove > spaceBelow;
      const overlayTrigger =
        Boolean(boundaryRect) &&
        (rect.top < boundaryTop ||
          rect.bottom > boundaryBottom ||
          Math.max(spaceAbove, spaceBelow) < Math.min(96, boundaryHeight));
      const availableHeight = overlayTrigger
        ? boundaryHeight
        : Math.max(placeAbove ? spaceAbove : spaceBelow, boundaryRect ? 0 : 96);

      listbox.style.setProperty("--radix-select-trigger-width", `${rect.width}px`);
      listbox.style.removeProperty("--radix-select-content-available-width");

      const measuredWidth = listbox.getBoundingClientRect().width;
      const preferredWidth = measuredWidth > 0 ? measuredWidth : Math.max(rect.width, 192);
      const maxViewportWidth = Math.max(window.innerWidth - gutter * 2, 0);
      const spaceRight = window.innerWidth - rect.left - gutter;
      const spaceLeft = rect.right - gutter;
      const alignEnd =
        align === "end"
          ? !(spaceLeft < preferredWidth && spaceRight > spaceLeft)
          : spaceRight < preferredWidth && spaceLeft > spaceRight;
      const fitsAligned = alignEnd ? spaceLeft >= preferredWidth : spaceRight >= preferredWidth;
      const clampedLeft = Math.max(
        gutter,
        Math.min(
          rect.left,
          window.innerWidth - gutter - Math.min(preferredWidth, maxViewportWidth),
        ),
      );
      const availableWidth = fitsAligned
        ? Math.max(alignEnd ? spaceLeft : spaceRight, rect.width)
        : Math.max(maxViewportWidth, rect.width);

      listbox.style.setProperty("--radix-select-content-available-width", `${availableWidth}px`);
      listbox.style.setProperty("--radix-select-content-available-height", `${availableHeight}px`);
      listbox.style.setProperty(
        "--radix-select-content-transform-origin",
        `${placeAbove && !overlayTrigger ? "bottom" : "top"} ${alignEnd ? "right" : "left"}`,
      );
      setPosition({
        bottom: placeAbove && !overlayTrigger ? origin.bottom - rect.top + sideOffset : undefined,
        left: !fitsAligned
          ? clampedLeft - origin.left
          : alignEnd
            ? undefined
            : rect.left - origin.left,
        position: "fixed",
        right: fitsAligned && alignEnd ? origin.right - rect.right : undefined,
        top: overlayTrigger
          ? boundaryTop - origin.top
          : placeAbove
            ? undefined
            : rect.bottom + sideOffset - origin.top,
      });
    }

    place();
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    if (scrollBoundary) resizeObserver?.observe(scrollBoundary);
    resizeObserver?.observe(anchor);
    resizeObserver?.observe(listbox);
    const viewport = scrollBoundary ? window.visualViewport : null;
    viewport?.addEventListener("resize", place);
    viewport?.addEventListener("scroll", place);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      resizeObserver?.disconnect();
      viewport?.removeEventListener("resize", place);
      viewport?.removeEventListener("scroll", place);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [align, anchor, container, open, ref]);

  if (!open || !anchor || !container) return null;

  return createPortal(
    <div
      {...props}
      className={cn("ui-select-content p-1", className)}
      ref={ref}
      style={position}
    />,
    container,
  );
}
