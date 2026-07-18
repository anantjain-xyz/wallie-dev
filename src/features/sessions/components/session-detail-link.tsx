"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  createContext,
  useContext,
  useState,
  type ComponentProps,
  type FocusEventHandler,
  type PointerEventHandler,
  type ReactNode,
} from "react";

import { startInteraction } from "@/lib/telemetry/interaction-rum";

type Prefetch = (href: string) => void;

const SessionDetailPrefetchContext = createContext<Set<string> | null>(null);

export function isSessionDetailHoverPointer(pointerType: string) {
  return pointerType === "mouse" || pointerType === "pen";
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
  "href" | "onFocus" | "onPointerEnter" | "prefetch"
> & {
  href: string;
  onFocus?: FocusEventHandler<HTMLAnchorElement>;
  onPointerEnter?: PointerEventHandler<HTMLAnchorElement>;
  trackSessionsToDetail?: boolean;
};

export function SessionDetailLink({
  href,
  onClick,
  onFocus,
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
      router.prefetch(nextHref);
    });
  }

  return (
    <Link
      {...props}
      href={href}
      prefetch={false}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented && trackSessionsToDetail) {
          startInteraction(
            "sessions_to_detail",
            "/w/[workspaceSlug]/sessions",
            "/w/[workspaceSlug]/sessions/[sessionNumber]",
          );
        }
      }}
      onFocus={(event) => {
        onFocus?.(event);
        if (!event.defaultPrevented) prefetch();
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
