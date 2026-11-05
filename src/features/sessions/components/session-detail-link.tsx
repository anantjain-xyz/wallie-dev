"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { PrefetchKind } from "next/dist/client/components/router-reducer/router-reducer-types";
import {
  createContext,
  useContext,
  useState,
  type ComponentProps,
  type FocusEventHandler,
  type PointerEventHandler,
  type ReactNode,
} from "react";

import { isUnmodifiedPrimaryClick, startInteraction } from "@/lib/telemetry/interaction-rum";

type Prefetch = (href: string) => void;

const SessionDetailPrefetchContext = createContext<Set<string> | null>(null);
const PREFETCH_SETTLE_TIMEOUT_MS = 2_000;

export function isSessionDetailHoverPointer(pointerType: string) {
  return pointerType === "mouse" || pointerType === "pen";
}

export function isSessionDetailPrefetchResource(resourceUrl: string, href: string) {
  try {
    const resource = new URL(resourceUrl);
    const target = new URL(href, resource.origin);
    return resource.pathname === target.pathname && resource.searchParams.has("_rsc");
  } catch {
    return false;
  }
}

export function prefetchSessionDetailOnce(
  prefetchedHrefs: Set<string>,
  href: string,
  prefetch: Prefetch,
) {
  if (prefetchedHrefs.has(href)) return;

  prefetchedHrefs.add(href);
  prefetch(href);
}

export function shouldReuseSessionDetailPrefetch(input: {
  defaultPrevented: boolean;
  prefetchStarted: boolean;
  unmodifiedPrimaryClick: boolean;
}) {
  return input.prefetchStarted && input.unmodifiedPrimaryClick && !input.defaultPrevented;
}

function sessionDetailPrefetchHasBody(entry: PerformanceResourceTiming) {
  return entry.responseEnd > 0 && (entry.decodedBodySize > 0 || entry.transferSize > 0);
}

function sessionDetailPrefetchSettled(href: string) {
  return performance.getEntriesByType("resource").some((entry) => {
    return (
      entry instanceof PerformanceResourceTiming &&
      isSessionDetailPrefetchResource(entry.name, href) &&
      sessionDetailPrefetchHasBody(entry)
    );
  });
}

function waitForSessionDetailPrefetch(href: string) {
  const settle = () =>
    new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });

  if (sessionDetailPrefetchSettled(href)) return settle();

  return new Promise<void>((resolve) => {
    const timeout = window.setTimeout(finish, PREFETCH_SETTLE_TIMEOUT_MS);
    const observer = new PerformanceObserver(() => {
      if (sessionDetailPrefetchSettled(href)) finish();
    });
    observer.observe({ type: "resource", buffered: true });

    function finish() {
      window.clearTimeout(timeout);
      observer.disconnect();
      void settle().then(resolve);
    }
  });
}

export function SessionDetailLinkPrefetchBoundary({ children }: { children: ReactNode }) {
  const [prefetchedHrefs] = useState(() => new Set<string>());

  return (
    <SessionDetailPrefetchContext.Provider value={prefetchedHrefs}>
      {children}
    </SessionDetailPrefetchContext.Provider>
  );
}

type SessionDetailLinkProps = Omit<
  ComponentProps<typeof Link>,
  "href" | "onFocus" | "onPointerDown" | "onPointerEnter" | "prefetch"
> & {
  href: string;
  onFocus?: FocusEventHandler<HTMLAnchorElement>;
  onPointerDown?: PointerEventHandler<HTMLAnchorElement>;
  onPointerEnter?: PointerEventHandler<HTMLAnchorElement>;
  trackSessionsToDetail?: boolean;
};

export function SessionDetailLink({
  href,
  onClick,
  onFocus,
  onPointerDown,
  onPointerEnter,
  trackSessionsToDetail = false,
  ...props
}: SessionDetailLinkProps) {
  const router = useRouter();
  const boundaryPrefetchedHrefs = useContext(SessionDetailPrefetchContext);
  const [localPrefetchedHrefs] = useState(() => new Set<string>());
  const prefetchedHrefs = boundaryPrefetchedHrefs ?? localPrefetchedHrefs;

  function prefetch() {
    prefetchSessionDetailOnce(prefetchedHrefs, href, (nextHref) => {
      router.prefetch(nextHref, { kind: PrefetchKind.FULL });
    });
  }

  return (
    <Link
      {...props}
      href={href}
      prefetch={false}
      onClick={(event) => {
        onClick?.(event);
        const unmodifiedPrimaryClick = isUnmodifiedPrimaryClick(event);
        if (!event.defaultPrevented && trackSessionsToDetail && unmodifiedPrimaryClick) {
          startInteraction(
            "sessions_to_detail",
            "/w/[workspaceSlug]/sessions",
            "/w/[workspaceSlug]/sessions/[sessionNumber]",
          );
        }
        // A click does not wait for an in-flight prefetch. It starts a second
        // navigation and aborts the first, so the opened row misses the cache
        // and renders through loading.tsx. Hold this click until the full
        // prefetch for this href has a body, then navigate from that cache.
        if (
          !shouldReuseSessionDetailPrefetch({
            defaultPrevented: event.defaultPrevented,
            prefetchStarted: prefetchedHrefs.has(href),
            unmodifiedPrimaryClick,
          })
        ) {
          return;
        }
        event.preventDefault();
        const destination = href;
        void waitForSessionDetailPrefetch(destination).then(() => {
          router.push(destination);
        });
      }}
      onFocus={(event) => {
        onFocus?.(event);
        if (!event.defaultPrevented) prefetch();
      }}
      onPointerDown={(event) => {
        onPointerDown?.(event);
        if (!event.defaultPrevented && isSessionDetailHoverPointer(event.pointerType)) {
          prefetch();
        }
      }}
      onPointerEnter={(event) => {
        onPointerEnter?.(event);
        if (!event.defaultPrevented && isSessionDetailHoverPointer(event.pointerType)) {
          prefetch();
        }
      }}
    />
  );
}
