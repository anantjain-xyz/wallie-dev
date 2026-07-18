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

export function RouteProgressProvider({ children }: { children: ReactNode }) {
  const startedAtRouteRef = useRef<string | null>(null);
  const activeRef = useRef(false);
  const frameRef = useRef<number | null>(null);
  const monitorFrameRef = useRef<number | null>(null);
  const timeoutRef = useRef<number | null>(null);
  const [visible, setVisible] = useState(false);

  const stopNavigation = useCallback(() => {
    activeRef.current = false;
    startedAtRouteRef.current = null;
    if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
    if (monitorFrameRef.current !== null) window.cancelAnimationFrame(monitorFrameRef.current);
    if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
    frameRef.current = null;
    monitorFrameRef.current = null;
    timeoutRef.current = null;
    setVisible(false);
  }, []);

  const startNavigation = useCallback(
    (href?: string) => {
      if (href && destinationKey(href) === browserRouteKey()) return;

      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
      if (monitorFrameRef.current !== null) {
        window.cancelAnimationFrame(monitorFrameRef.current);
        monitorFrameRef.current = null;
      }
      if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);

      activeRef.current = true;
      startedAtRouteRef.current = browserRouteKey();
      setVisible(false);
      frameRef.current = window.requestAnimationFrame(() => {
        frameRef.current = null;
        if (!activeRef.current) return;
        if (startedAtRouteRef.current !== browserRouteKey()) {
          stopNavigation();
          return;
        }

        setVisible(true);
        const monitorRoute = () => {
          if (!activeRef.current) return;
          if (startedAtRouteRef.current !== browserRouteKey()) {
            stopNavigation();
            return;
          }
          monitorFrameRef.current = window.requestAnimationFrame(monitorRoute);
        };
        monitorFrameRef.current = window.requestAnimationFrame(monitorRoute);
      });
      // A failed navigation must not leave permanent chrome on screen.
      timeoutRef.current = window.setTimeout(stopNavigation, 15_000);
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
      {visible ? (
        <div aria-live="polite" className="ui-route-progress" data-route-progress role="status">
          <span className="sr-only">Loading page…</span>
          <span aria-hidden="true" className="ui-route-progress-value" />
        </div>
      ) : null}
    </RouteProgressContext>
  );
}
