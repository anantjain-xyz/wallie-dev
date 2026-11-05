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
import { sessionPageDataResponseEnd } from "@/lib/performance/session-prefetch";

type Prefetch = (href: string) => void;

const SessionDetailPrefetchContext = createContext<Map<string, number> | null>(null);
const PREFETCH_SETTLE_TIMEOUT_MS = 2_000;
const PREFETCH_QUIET_MS = 80;

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
  prefetchedHrefs: Map<string, number>,
  href: string,
  prefetch: Prefetch,
) {
  if (prefetchedHrefs.has(href)) return;

  prefetchedHrefs.set(href, performance.now());
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

function waitForSessionDetailPrefetch(href: string, intentStartedAt: number) {
  // A full prefetch can be more than one RSC response. Navigating on the first
  // one aborts the rest. Wait until the burst has gone quiet.
  return new Promise<void>((resolve) => {
    let quietTimer = 0;
    let settled = false;
    let latestPageResponseEnd: number | null = null;
    const timeout = window.setTimeout(finish, PREFETCH_SETTLE_TIMEOUT_MS);
    const observer = new PerformanceObserver((list) => {
      observeResponses(list.getEntries());
    });
    observer.observe({ type: "resource", buffered: true });
    observeResponses(performance.getEntriesByType("resource"));

    function observeResponses(entries: PerformanceEntry[]) {
      for (const entry of entries) {
        if (
          !(entry instanceof PerformanceResourceTiming) ||
          !isSessionDetailPrefetchResource(entry.name, href) ||
          !sessionDetailPrefetchHasBody(entry)
        ) {
          continue;
        }
        const responseEnd = sessionPageDataResponseEnd(
          entry,
          href,
          intentStartedAt,
          location.origin,
        );
        if (responseEnd !== null) {
          latestPageResponseEnd = Math.max(latestPageResponseEnd ?? 0, responseEnd);
        }
        const delay =
          latestPageResponseEnd === null
            ? PREFETCH_QUIET_MS
            : Math.max(0, latestPageResponseEnd + PREFETCH_QUIET_MS - performance.now());
        window.clearTimeout(quietTimer);
        quietTimer = window.setTimeout(finish, delay);
      }
    }

    function finish() {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      window.clearTimeout(quietTimer);
      observer.disconnect();
      requestAnimationFrame(() => resolve());
    }
  });
}

export function SessionDetailLinkPrefetchBoundary({ children }: { children: ReactNode }) {
  const [prefetchedHrefs] = useState(() => new Map<string, number>());

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
  const [localPrefetchedHrefs] = useState(() => new Map<string, number>());
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
        void waitForSessionDetailPrefetch(destination, prefetchedHrefs.get(destination)!).then(
          () => {
            router.push(destination);
          },
        );
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
