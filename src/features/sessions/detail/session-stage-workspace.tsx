"use client";

import { type ReactNode, useState } from "react";
import { ChevronDownIcon } from "@/components/shared/icons/chevron-down-icon";
import { SessionRunFocusProvider } from "./session-activity-presentation";

export type SessionStageFocus = "run" | "artifact" | "empty";

/** Keep the live activity subtree mounted across presentation changes and disclosure. */
export function SessionStageWorkspace({
  activity,
  artifact,
  emptyText,
  focus,
  reviewControls,
  stageName,
  stageSlug,
}: {
  activity: ReactNode;
  artifact: ReactNode;
  emptyText: string;
  focus: SessionStageFocus;
  reviewControls: ReactNode;
  stageName: string;
  stageSlug: string;
}) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const showingArtifact = focus === "artifact";
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <section
        aria-label={showingArtifact ? `${stageName} artifact` : undefined}
        className={showingArtifact ? "ui-sheet min-w-0" : "contents"}
      >
        {showingArtifact ? (
          <>
            <div className="border-b border-border px-4 py-4 sm:px-5">
              <h2 className="text-base font-semibold text-foreground">{stageName} artifact</h2>
            </div>
            <div className="min-w-0 p-4 sm:p-5">{artifact}</div>
          </>
        ) : null}
        {reviewControls}
      </section>
      {focus === "empty" ? (
        <section className="py-3" aria-label={`${stageName} stage`}>
          <h2 className="text-base font-semibold">{stageName}</h2>
          <p className="mt-1 text-sm text-muted">{emptyText}</p>
        </section>
      ) : null}
      <details
        aria-label="Session runs"
        className="group/session-history min-w-0"
        open={focus === "run" || historyOpen}
        onToggle={(event) => {
          if (focus !== "run") setHistoryOpen(event.currentTarget.open);
        }}
      >
        <summary
          id="session-runs-heading"
          hidden={focus === "run"}
          className="flex min-h-9 cursor-pointer list-none items-center gap-2 rounded-[4px] text-xs text-muted hover:text-foreground focus-visible:outline-accent [&::-webkit-details-marker]:hidden"
        >
          <ChevronDownIcon className="size-3.5 -rotate-90 group-open/session-history:rotate-0" />
          Run history
        </summary>
        <div className={focus === "run" ? "min-w-0" : "mt-3 min-w-0"}>
          <SessionRunFocusProvider value={focus === "run"}>{activity}</SessionRunFocusProvider>
        </div>
      </details>
      {focus === "run" && artifact ? (
        <PreviousArtifact key={stageSlug}>{artifact}</PreviousArtifact>
      ) : null}
    </div>
  );
}

function PreviousArtifact({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="group/previous min-w-0 border-t border-border pt-3"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="flex min-h-9 cursor-pointer list-none flex-wrap items-center gap-2 rounded-[4px] text-xs text-muted hover:text-foreground focus-visible:outline-accent [&::-webkit-details-marker]:hidden">
        <ChevronDownIcon className="size-3.5 -rotate-90 group-open/previous:rotate-0" />
        Previous artifact
        <span className="type-annotation">Earlier output · not ready for review</span>
      </summary>
      {open ? <div className="mt-3 min-w-0">{children}</div> : null}
    </details>
  );
}
