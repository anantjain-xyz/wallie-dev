"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { useAnnouncementContainer } from "@/components/ui/portal-root";

export type AnnouncementPriority = "polite" | "assertive";

type LiveRegionContextValue = {
  announce: (message: string, priority?: AnnouncementPriority) => void;
};

const LiveRegionContext = createContext<LiveRegionContextValue | null>(null);

export function useLiveRegion() {
  const context = useContext(LiveRegionContext);

  if (!context) {
    throw new Error("useLiveRegion must be used within OverlayProvider");
  }

  return context;
}

/** Safe in SSR/smoke renders outside OverlayProvider; announcements no-op. */
export function useOptionalLiveRegion() {
  return useContext(LiveRegionContext) ?? { announce: () => undefined };
}

export function LiveRegionProvider({ children }: { children: ReactNode }) {
  const container = useAnnouncementContainer();
  const [politeMessage, setPoliteMessage] = useState("");
  const [assertiveMessage, setAssertiveMessage] = useState("");
  const politeTimer = useRef<number | null>(null);
  const assertiveTimer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (politeTimer.current !== null) window.clearTimeout(politeTimer.current);
      if (assertiveTimer.current !== null) window.clearTimeout(assertiveTimer.current);
    };
  }, []);

  const announce = useCallback((message: string, priority: AnnouncementPriority = "polite") => {
    if (priority === "assertive") {
      if (assertiveTimer.current !== null) window.clearTimeout(assertiveTimer.current);
      setAssertiveMessage("");
      assertiveTimer.current = window.setTimeout(() => setAssertiveMessage(message), 20);
      return;
    }

    if (politeTimer.current !== null) window.clearTimeout(politeTimer.current);
    setPoliteMessage("");
    politeTimer.current = window.setTimeout(() => setPoliteMessage(message), 20);
  }, []);
  const context = useMemo(() => ({ announce }), [announce]);

  return (
    <LiveRegionContext value={context}>
      {children}
      {container
        ? createPortal(
            <>
              <div
                aria-atomic="true"
                aria-live="polite"
                className="sr-only"
                data-live-region="polite"
                role="status"
              >
                {politeMessage}
              </div>
              <div
                aria-atomic="true"
                aria-live="assertive"
                className="sr-only"
                data-live-region="assertive"
                role="alert"
              >
                {assertiveMessage}
              </div>
            </>,
            container,
          )
        : null}
    </LiveRegionContext>
  );
}
