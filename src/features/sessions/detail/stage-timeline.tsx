"use client";

import { useEffect, useRef } from "react";

import { CheckIcon } from "@/components/shared/icons/check-icon";
import type { SessionReviewPipeline, SessionReviewSession } from "@/features/sessions/detail/data";
import type { SessionPhaseStatus } from "@/features/sessions/types";
import { cn } from "@/lib/utils";

export type StageTimelineStatus =
  | "completed"
  | "current"
  | "upcoming"
  | "failed"
  | "not_running"
  | "unapproved";

export type StageTimelineEntry = {
  phaseStatus: SessionPhaseStatus | null;
  stage: SessionReviewPipeline["stages"][number];
  status: StageTimelineStatus;
};

function stageIndex(pipeline: SessionReviewPipeline, stageId: string): number {
  return pipeline.stages.findIndex((stage) => stage.id === stageId);
}

export function buildStageTimeline(
  session: SessionReviewSession,
  options?: { failedStageSlug?: string | null },
): StageTimelineEntry[] {
  const completedStageIds = new Set(
    session.phaseCompletions
      .filter((completion) => completion.stageId && completion.completedAt)
      .map((completion) => completion.stageId),
  );
  const completedLegacySlugs = new Set(
    session.phaseCompletions
      .filter((completion) => !completion.stageId && completion.completedAt)
      .map((completion) => completion.stageSlug),
  );
  const currentIdx = stageIndex(session.pipeline, session.currentStageId);
  const failedStageSlug = options?.failedStageSlug ?? null;

  return session.pipeline.stages.map((stage, idx) => {
    // Live ordering can revisit an approved stage. Its active state takes
    // precedence over a completion recorded on a previous visit.
    if (idx === currentIdx) {
      if (session.phaseStatus === "approved") {
        return { phaseStatus: null, stage, status: "completed" as const };
      }
      if (failedStageSlug === stage.slug) {
        return { phaseStatus: session.phaseStatus, stage, status: "failed" as const };
      }
      return {
        phaseStatus: session.phaseStatus,
        stage,
        status:
          session.phaseStatus === "rejected" ? ("not_running" as const) : ("current" as const),
      };
    }

    if (completedStageIds.has(stage.id) || completedLegacySlugs.has(stage.slug)) {
      return { phaseStatus: null, stage, status: "completed" as const };
    }
    if (failedStageSlug === stage.slug) {
      return { phaseStatus: null, stage, status: "failed" as const };
    }
    return {
      phaseStatus: null,
      stage,
      status:
        session.phaseStatus === "approved" || idx < currentIdx
          ? ("unapproved" as const)
          : ("upcoming" as const),
    };
  });
}

export function centerStageTimelineSelection(
  rail: HTMLOListElement,
  selectedButton: HTMLButtonElement,
) {
  if (rail.scrollWidth <= rail.clientWidth) return;

  rail.scrollTo({
    behavior: "auto",
    left: Math.max(
      0,
      selectedButton.offsetLeft - (rail.clientWidth - selectedButton.offsetWidth) / 2,
    ),
  });
}

export function stageTimelineLabel(entry: StageTimelineEntry): string {
  switch (entry.status) {
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "not_running":
      return "Not running";
    case "unapproved":
      return "Not approved";
    case "upcoming":
      return "Upcoming";
    case "current":
      return entry.phaseStatus === "awaiting_review" ? "Awaiting review" : "In progress";
  }
}

type StageTimelineProps = {
  onSelect: (stageSlug: string) => void;
  selectedStageSlug: string;
  timeline: StageTimelineEntry[];
};

export function StageTimeline({ onSelect, selectedStageSlug, timeline }: StageTimelineProps) {
  const railRef = useRef<HTMLOListElement>(null);
  const buttonRefs = useRef(new Map<string, HTMLButtonElement>());

  useEffect(() => {
    const rail = railRef.current;
    const selectedButton = buttonRefs.current.get(selectedStageSlug);
    if (rail && selectedButton) centerStageTimelineSelection(rail, selectedButton);
  }, [selectedStageSlug]);

  return (
    <nav aria-label="Pipeline stages" className="border-b border-border pb-3">
      <ol className="flex flex-wrap items-center gap-1.5" ref={railRef}>
        {timeline.map((entry, index) => {
          const isSelected = entry.stage.slug === selectedStageSlug;
          const label = stageTimelineLabel(entry);
          const isCurrent = entry.phaseStatus !== null && entry.status !== "completed";
          return (
            <li key={entry.stage.id} className="flex min-w-0 items-center gap-1.5">
              <button
                ref={(node) => {
                  if (node) {
                    buttonRefs.current.set(entry.stage.slug, node);
                  } else {
                    buttonRefs.current.delete(entry.stage.slug);
                  }
                }}
                type="button"
                onClick={() => onSelect(entry.stage.slug)}
                className={cn(
                  "group flex min-w-0 max-w-full items-center gap-2 rounded-[6px] px-3 py-2 text-left text-xs font-medium transition-colors",
                  isSelected
                    ? "bg-accent-soft text-accent"
                    : "text-muted hover:bg-control-muted hover:text-foreground",
                )}
                aria-label={`${entry.stage.name}: ${label}`}
                aria-current={isCurrent ? "step" : undefined}
                aria-pressed={isSelected}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-xs",
                    entry.status === "completed"
                      ? "border-success/30 bg-success-soft text-success"
                      : entry.status === "failed"
                        ? "border-danger/30 bg-danger-soft text-danger"
                        : entry.status === "not_running"
                          ? "border-warning/30 bg-warning-soft text-warning"
                          : isCurrent
                            ? "border-accent bg-accent-soft text-accent"
                            : "border-border text-muted",
                  )}
                >
                  {entry.status === "completed" ? (
                    <CheckIcon className="h-3.5 w-3.5" />
                  ) : entry.status === "failed" || entry.status === "not_running" ? (
                    "!"
                  ) : (
                    index + 1
                  )}
                </span>
                <span className="min-w-0 [overflow-wrap:anywhere]">
                  <span className="block text-foreground">{entry.stage.name}</span>
                  <span className="block font-normal">{label}</span>
                </span>
              </button>
              {index < timeline.length - 1 ? (
                <span aria-hidden="true" className="hidden h-px w-3 bg-border sm:block" />
              ) : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
