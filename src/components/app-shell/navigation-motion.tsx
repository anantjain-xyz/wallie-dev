"use client";

import { useLayoutEffect, useRef, type ReactNode } from "react";
import { enterContent } from "@/components/ui/motion";
import { cn } from "@/lib/utils";

export function WorkspaceNavigation({
  children,
  className,
  pathname,
}: {
  children: ReactNode;
  className?: string;
  pathname: string;
}) {
  const navRef = useRef<HTMLElement>(null);
  const measureRef = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    let frame = 0;
    const measure = (resize = false) => {
      const active = nav.querySelector<HTMLElement>('[aria-current="page"]');
      if (!active || !active.offsetWidth) {
        delete nav.dataset.indicatorReady;
        return;
      }
      const { offsetLeft: left, offsetTop: top, offsetWidth: width, offsetHeight: height } = active;
      if (resize) delete nav.dataset.indicatorAnimated;
      nav.style.setProperty("--nav-x", `${left}px`);
      nav.style.setProperty("--nav-y", `${top}px`);
      nav.style.setProperty("--nav-width", `${width}px`);
      nav.style.setProperty("--nav-height", `${height}px`);
      nav.dataset.indicatorReady = "true";
      // Keep the active tab visible when the compact mobile row clips the scroller.
      active.scrollIntoView({ block: "nearest", inline: "nearest" });
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        nav.dataset.indicatorAnimated = "true";
      });
    };
    measureRef.current = () => measure();
    measure();
    const observer = new ResizeObserver(() => measure(true));
    observer.observe(nav);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, []);
  useLayoutEffect(() => {
    measureRef.current?.();
  }, [pathname]);
  return (
    <nav aria-label="Workspace navigation" className={cn("ui-shell-nav", className)} ref={navRef}>
      <span aria-hidden="true" className="ui-shell-nav-indicator" />
      {children}
    </nav>
  );
}

/** Animate the committed page once its streamed content is usable, preserving its mounted state. */
export function RouteEntrance({ pathname }: { pathname: string }) {
  const previousPath = useRef(pathname);
  useLayoutEffect(() => {
    if (previousPath.current === pathname) return;
    previousPath.current = pathname;
    const main = document.getElementById("main-content");
    if (!main) return;
    let animation: Animation | null = null;
    const observer = new MutationObserver(reveal);
    function reveal() {
      if (!main || main.querySelector("[data-route-loading]") || !main.querySelector("h1")) return;
      observer.disconnect();
      animation = enterContent(main);
    }
    observer.observe(main, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-route-loading"],
    });
    reveal();
    return () => {
      observer.disconnect();
      animation?.cancel();
    };
  }, [pathname]);
  return null;
}
