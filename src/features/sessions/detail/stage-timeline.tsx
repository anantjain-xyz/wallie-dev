"use client";

import { useEffect, useRef } from "react";

import { Status, sessionPhaseStatusValue, type StatusValue } from "@/components/ui/status";
import type { SessionReviewPipeline, SessionReviewSession } from "@/features/sessions/detail/data";
import type { SessionPhaseStatus } from "@/features/sessions/types";
import { cn } from "@/lib/utils";

export type StageTimelineStatus =
  | "completed"
  | "current"
  | "upcoming"
  | "failed"
  | "changes_requested";

export type StageTimelineEntry = {
  phaseStatus: SessionPhaseStatus | null;
  stage: SessionReviewPipeline["stages"][number];
  status: StageTimelineStatus;
};

function stageIndex(pipeline: SessionReviewPipeline, stageSlug: string): number {
  return pipeline.stages.findIndex((stage) => stage.slug === stageSlug);
}

export function buildStageTimeline(
  session: SessionReviewSession,
  options?: { failedStageSlug?: string | null },
): StageTimelineEntry[] {
  const completionIndex = new Map(
    session.phaseCompletions.map((completion) => [completion.stageSlug, completion.completedAt]),
  );
  const currentIdx = stageIndex(session.pipeline, session.currentStageSlug);
  const failedStageSlug = options?.failedStageSlug ?? null;

  return session.pipeline.stages.map((stage, idx) => {
    const completedAt = completionIndex.get(stage.slug) ?? null;

    if (failedStageSlug === stage.slug) {
      return {
        phaseStatus: session.phaseStatus,
        stage,
        status: "failed" as const,
      };
    }

    if (idx < currentIdx || completedAt) {
      return {
        phaseStatus: null,
        stage,
        status: "completed" as const,
      };
    }

    if (idx === currentIdx) {
      if (session.phaseStatus === "rejected") {
        return {
          phaseStatus: session.phaseStatus,
          stage,
          status: "changes_requested" as const,
        };
      }

      return {
        phaseStatus: session.phaseStatus,
        stage,
        status: "current" as const,
      };
    }

    return {
      phaseStatus: null,
      stage,
      status: "upcoming" as const,
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

function timelineStatusValue(entry: StageTimelineEntry): StatusValue {
  if (entry.status === "completed") return "complete";
  if (entry.status === "upcoming") return "upcoming";
  if (entry.status === "failed") return "failed";
  if (entry.status === "changes_requested") return "rejected";
  return sessionPhaseStatusValue(entry.phaseStatus ?? "agent_generating");
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
                  "group flex items-center gap-1.5 rounded-[4px] px-2 py-1 text-xs font-medium transition-colors",
                  isSelected
                    ? "bg-accent-soft text-accent"
                    : "text-muted hover:bg-control-muted hover:text-foreground",
                )}
                aria-current={isSelected ? "step" : undefined}
              >
                <Status compact value={timelineStatusValue(entry)} />
                <span>{entry.stage.name}</span>
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
