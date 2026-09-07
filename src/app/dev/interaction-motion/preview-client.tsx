"use client";

import { useState } from "react";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { ArtifactPanel } from "@/features/sessions/detail/artifact-panel";
import { SessionCompletionSummary } from "@/features/sessions/detail/session-completion-summary";
import { StageTimeline, type StageTimelineEntry } from "@/features/sessions/detail/stage-timeline";
import {
  SessionExecutionProvider,
  SessionExecutionSummary,
  usePublishExecution,
} from "@/features/sessions/detail/execution-summary";
import type { SessionPhaseStatus } from "@/features/sessions/types";

const stages = [
  { description: "Plan", id: "plan", name: "Plan", position: 0, slug: "plan" },
  { description: "Build", id: "build", name: "Build", position: 1, slug: "build" },
];

/** Exercise real UI components without launching runs or changing workspace data. */
export function InteractionMotionPreview({ initialNow }: { initialNow: string }) {
  return (
    <SessionExecutionProvider>
      <InteractionMotionContent initialNow={initialNow} />
    </SessionExecutionProvider>
  );
}

function InteractionMotionContent({ initialNow }: { initialNow: string }) {
  usePublishExecution({
    sessionId: "preview",
    run: undefined,
    connection: "live",
    nowMs: Date.parse(initialNow),
    stallTimeoutMs: 60000,
  });
  const [phaseStatus, setPhaseStatus] = useState<SessionPhaseStatus>("in_progress");
  const [version, setVersion] = useState(1);
  const [refresh, setRefresh] = useState(0);
  const [selected, setSelected] = useState("build");
  const timeline: StageTimelineEntry[] = stages.map((stage) => ({
    stage,
    phaseStatus: stage.slug === "build" && phaseStatus !== "approved" ? phaseStatus : null,
    status: stage.slug === "plan" || phaseStatus === "approved" ? "completed" : "current",
  }));
  return (
    <main className="mx-auto max-w-4xl space-y-6 p-5 sm:p-10">
      <h1 className="text-2xl font-semibold">Session interaction preview</h1>
      <div className="flex flex-wrap gap-2">
        <button className="ui-button" onClick={() => setPhaseStatus("in_progress")}>
          Running
        </button>
        <button className="ui-button" onClick={() => setPhaseStatus("awaiting_review")}>
          Ready for review
        </button>
        <button className="ui-button" onClick={() => setPhaseStatus("approved")}>
          Complete session
        </button>
        <button className="ui-button" onClick={() => setVersion((value) => value + 1)}>
          New artifact version
        </button>
        <button className="ui-button" onClick={() => setRefresh((value) => value + 1)}>
          Refresh snapshot
        </button>
        <Dialog>
          <DialogTrigger className="ui-button">Open dialog</DialogTrigger>
          <DialogContent title="Interaction preview">
            <p>Press Escape to return to the trigger.</p>
          </DialogContent>
        </Dialog>
      </div>
      <p className="text-xs text-muted">Snapshot refreshes: {refresh}</p>
      <StageTimeline timeline={timeline} selectedStageSlug={selected} onSelect={setSelected} />
      <SessionExecutionSummary
        sessionId="preview"
        stageId="build"
        stageName="Build"
        phaseStatus={phaseStatus}
        archivedAt={null}
        initialNow={initialNow}
      />
      <SessionCompletionSummary session={{ phaseStatus, pullRequests: [] }} />
      <ArtifactPanel
        emptyText="No artifact yet."
        initialFormattedArtifact={
          <div>
            <h2>Implementation complete</h2>
            <p>Version {version} is ready for review.</p>
          </div>
        }
        initialFormattedArtifactKey={`preview:build:${version}`}
        initialNow={initialNow}
        isDrafting={false}
        latestArtifact={{
          createdAt: initialNow,
          payload: `# Implementation complete\n\nVersion ${version} is ready for review.`,
          stageSlug: "build",
          version,
        }}
        loadLatest={true}
        sessionId="preview"
        stageSlug="build"
      />
    </main>
  );
}
