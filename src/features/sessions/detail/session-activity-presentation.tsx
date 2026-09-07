"use client";

import { createContext, type ReactNode, useContext } from "react";
import type { SessionPhaseStatus } from "@/features/sessions/types";

export type SessionActivityPresentation = {
  currentStage: { id: string; name: string; phaseStatus: SessionPhaseStatus };
  /** Undefined uses run-level cancellation; null deliberately hides it. */
  stopControl: ReactNode;
};

const PresentationContext = createContext<SessionActivityPresentation | undefined>(undefined);
export const SessionActivityPresentationProvider = PresentationContext.Provider;
export function useSessionActivityPresentation() {
  return useContext(PresentationContext);
}

const RunFocusContext = createContext(true);
export const SessionRunFocusProvider = RunFocusContext.Provider;
export function useSessionRunFocus() {
  return useContext(RunFocusContext);
}

export function SessionRunSurface({ children }: { children: ReactNode }) {
  const focused = useContext(RunFocusContext);
  return <div className={focused ? "ui-sheet min-w-0 p-4 sm:p-5" : "min-w-0"}>{children}</div>;
}

/** Keep older runs visible; each run owns its own disclosure. */
export function SessionRunHistory({
  children,
  count,
  hasMore = false,
}: {
  children: ReactNode;
  count: number;
  hasMore?: boolean;
}) {
  const focused = useContext(RunFocusContext);
  return (
    <section aria-labelledby={focused ? "previous-runs-heading" : undefined} className="min-w-0">
      {focused ? (
        <h2
          id="previous-runs-heading"
          className="mb-2 flex items-center gap-2 text-base font-semibold text-foreground"
        >
          Run history
          <span className="type-annotation font-normal text-muted">
            {count}
            {hasMore ? "+" : ""}
          </span>
        </h2>
      ) : null}
      {children}
    </section>
  );
}

/** Preserve session cancellation even before activity loads or when it fails to load. */
export function SessionActivityPlaceholder({ children }: { children: ReactNode }) {
  const presentation = useSessionActivityPresentation();
  return (
    <SessionRunSurface>
      {presentation ? (
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <h2 className="text-base font-semibold">{presentation.currentStage.name} run</h2>
          {presentation.stopControl}
        </div>
      ) : null}
      {children}
    </SessionRunSurface>
  );
}
