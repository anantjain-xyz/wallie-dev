"use client";

import { createContext, type ReactNode, useContext } from "react";
import type { SessionPhaseStatus } from "@/features/sessions/types";

export type SessionActivityPresentation = {
  currentStage: { id: string; name: string; phaseStatus: SessionPhaseStatus };
  stopControl: ReactNode;
};

const PresentationContext = createContext<SessionActivityPresentation | undefined>(undefined);
export const SessionActivityPresentationProvider = PresentationContext.Provider;
export function useSessionActivityPresentation() {
  return useContext(PresentationContext);
}

/** Preserve session cancellation even before activity loads or when it fails to load. */
export function SessionActivityPlaceholder({ children }: { children: ReactNode }) {
  const presentation = useSessionActivityPresentation();
  return (
    <div className="min-w-0">
      {presentation ? (
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <h2 className="text-base font-semibold">{presentation.currentStage.name} run</h2>
          {presentation.stopControl}
        </div>
      ) : null}
      {children}
    </div>
  );
}
