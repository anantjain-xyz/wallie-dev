"use client";

import { createContext, type ReactNode, useContext, useState } from "react";
import { ChevronDownIcon } from "@/components/shared/icons/chevron-down-icon";
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

export function SessionRunSurface({ children }: { children: ReactNode }) {
  const focused = useContext(RunFocusContext);
  return <div className={focused ? "ui-sheet min-w-0 p-4 sm:p-5" : "min-w-0"}>{children}</div>;
}

/** Keep history mounted and avoid a second disclosure inside the artifact view's history. */
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
  const [open, setOpen] = useState(false);
  return (
    <details
      className="group/previous-runs min-w-0"
      open={!focused || open}
      onToggle={(event) => {
        if (focused) setOpen(event.currentTarget.open);
      }}
    >
      <summary
        id="previous-runs-heading"
        hidden={!focused}
        className="flex min-h-9 cursor-pointer list-none items-center gap-2 rounded-[4px] text-xs text-muted hover:text-foreground focus-visible:outline-accent [&::-webkit-details-marker]:hidden"
      >
        <ChevronDownIcon className="size-3.5 -rotate-90 group-open/previous-runs:rotate-0" />
        Run history{" "}
        <span className="type-annotation">
          {count}
          {hasMore ? "+" : ""}
        </span>
      </summary>
      {children}
    </details>
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
