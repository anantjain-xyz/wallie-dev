"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";

type RouteProgressContextValue = {
  startNavigation: (href?: string) => void;
};

const RouteProgressContext = createContext<RouteProgressContextValue | null>(null);
const optionalRouteProgressContext: RouteProgressContextValue = { startNavigation: () => {} };

export function useRouteProgress() {
  const context = useContext(RouteProgressContext);

  if (!context) throw new Error("useRouteProgress must be used within RouteProgressProvider");

  return context;
}

/** Allows route-owning screens to render outside the root shell in unit tests. */
export function useOptionalRouteProgress() {
  return useContext(RouteProgressContext) ?? optionalRouteProgressContext;
}

function routeKey(pathname: string, search: string) {
  return search ? `${pathname}?${search}` : pathname;
}

function destinationKey(href: string) {
  const destination = new URL(href, window.location.href);
  return routeKey(destination.pathname, destination.searchParams.toString());
}

function browserRouteKey() {
  return routeKey(window.location.pathname, window.location.search.slice(1));
}

export function shouldTrackRouteClick(
  event: MouseEvent | ReactMouseEvent,
  anchor: HTMLAnchorElement,
) {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey ||
    anchor.download ||
    (anchor.target && anchor.target !== "_self")
  ) {
    return false;
  }

  const destination = new URL(anchor.href, window.location.href);
  if (destination.origin !== window.location.origin) return false;
  if (destination.protocol !== "http:" && destination.protocol !== "https:") return false;

  return destinationKey(destination.href) !== browserRouteKey();
}

/** Initial route skeletons are busy status regions; active runs are not. */
export function hasUsableRouteContent() {
  const main = document.getElementById("main-content");
  return Boolean(
    main &&
    document.querySelector("h1") &&
    !main.querySelector('[role="status"][aria-busy="true"]'),
  );
}

export function RouteProgressProvider({ children }: { children: ReactNode }) {
  const startedAtRouteRef = useRef<string | null>(null);
  const activeRef = useRef(false);
  const initialErrorRef = useRef<Element | null>(null);
  const frameRef = useRef<number | null>(null);
  const monitorFrameRef = useRef<number | null>(null);
  const timeoutRef = useRef<number | null>(null);
  const [visible, setVisible] = useState(false);
  const [slow, setSlow] = useState(false);
  const [requestedHref, setRequestedHref] = useState<string | null>(null);
  const showTimerRef = useRef<number | null>(null);

  const stopNavigation = useCallback(() => {
    activeRef.current = false;
    startedAtRouteRef.current = null;
    if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
    if (monitorFrameRef.current !== null) window.cancelAnimationFrame(monitorFrameRef.current);
    if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
    frameRef.current = null;
    monitorFrameRef.current = null;
    timeoutRef.current = null;
    if (showTimerRef.current !== null) window.clearTimeout(showTimerRef.current);
    showTimerRef.current = null;
    setVisible(false);
    setSlow(false);
  }, []);

  const startNavigation = useCallback(
    (href?: string) => {
      if (href && destinationKey(href) === browserRouteKey()) {
        if (hasUsableRouteContent()) stopNavigation();
        return;
      }

      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
      if (monitorFrameRef.current !== null) {
        window.cancelAnimationFrame(monitorFrameRef.current);
        monitorFrameRef.current = null;
      }
      if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);

      if (showTimerRef.current !== null) window.clearTimeout(showTimerRef.current);
      setSlow(false);
      setRequestedHref(href ?? null);
      activeRef.current = true;
      initialErrorRef.current = document.querySelector("[data-route-error]");
      startedAtRouteRef.current = browserRouteKey();
      setVisible(false);
      frameRef.current = window.requestAnimationFrame(() => {
        frameRef.current = null;
        if (!activeRef.current) return;
        if (startedAtRouteRef.current !== browserRouteKey() && hasUsableRouteContent()) {
          stopNavigation();
          return;
        }

        const monitorRoute = () => {
          if (!activeRef.current) return;
          if (
            (document.querySelector("[data-route-error]") &&
              document.querySelector("[data-route-error]") !== initialErrorRef.current) ||
            (startedAtRouteRef.current !== browserRouteKey() && hasUsableRouteContent())
          ) {
            stopNavigation();
            return;
          }
          monitorFrameRef.current = window.requestAnimationFrame(monitorRoute);
        };
        monitorFrameRef.current = window.requestAnimationFrame(monitorRoute);
      });
      showTimerRef.current = window.setTimeout(() => {
        showTimerRef.current = null;
        if (activeRef.current) setVisible(true);
      }, 150);
      // A timeout is not proof of success. Keep waiting and offer an explicit recovery path.
      timeoutRef.current = window.setTimeout(() => {
        if (activeRef.current) setSlow(true);
      }, 15_000);
    },
    [stopNavigation],
  );

  useEffect(() => {
    function handleClick(event: MouseEvent) {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest<HTMLAnchorElement>("a[href]");
      if (!anchor || !shouldTrackRouteClick(event, anchor)) return;
      startNavigation(anchor.href);
    }

    document.addEventListener("click", handleClick, true);
    return () => {
      document.removeEventListener("click", handleClick, true);
      stopNavigation();
    };
  }, [startNavigation, stopNavigation]);

  const context = useMemo(() => ({ startNavigation }), [startNavigation]);

  return (
    <RouteProgressContext value={context}>
      {children}
      {slow ? (
        <div
          className="ui-sheet fixed left-4 right-4 top-16 z-50 mx-auto max-w-lg p-4"
          role="status"
        >
          <p className="text-sm font-semibold text-foreground">
            This page is taking longer than usual.
          </p>
          <p className="mt-1 text-sm text-muted">You can keep waiting or try opening it again.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <a className="ui-button" href={requestedHref ?? browserRouteKey()}>
              Open page again
            </a>
            <button type="button" className="ui-button" onClick={stopNavigation}>
              Dismiss
            </button>
          </div>
        </div>
      ) : null}
      {visible ? (
        <div aria-live="polite" className="ui-route-progress" data-route-progress role="status">
          <span className="sr-only">Loading page…</span>
          <span aria-hidden="true" className="ui-route-progress-value" />
        </div>
      ) : null}
    </RouteProgressContext>
  );
}
