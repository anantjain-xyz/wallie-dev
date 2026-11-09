"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { ArtifactPanel, artifactBodyCacheKey } from "@/features/sessions/detail/artifact-panel";
import { sessionReviewReadOnlyReason } from "@/features/sessions/review/comment-access";
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

type ReviewFixtureArtifact = { source: string; html: string; version: number };

/** Exercise real UI components without launching runs or changing workspace data. */
export function InteractionMotionPreview({
  initialNow,
  reviewArtifact,
}: {
  initialNow: string;
  reviewArtifact: ReviewFixtureArtifact;
}) {
  return (
    <SessionExecutionProvider>
      <InteractionMotionContent initialNow={initialNow} reviewArtifact={reviewArtifact} />
    </SessionExecutionProvider>
  );
}

function InteractionMotionContent({
  initialNow,
  reviewArtifact,
}: {
  initialNow: string;
  reviewArtifact: ReviewFixtureArtifact;
}) {
  const reviewState = useSearchParams().get("reviewState");
  const reviewFixture = ["editable", "approved", "archived"].includes(reviewState ?? "");
  const artifactId = reviewFixture ? "11111111-1111-4111-8111-111111111111" : undefined;
  const archivedAt = reviewState === "archived" ? "2026-11-08T12:00:00Z" : null;
  usePublishExecution({
    sessionId: "preview",
    run: undefined,
    connection: "live",
    nowMs: Date.parse(initialNow),
    stallTimeoutMs: 60000,
  });
  const [phaseStatus, setPhaseStatus] = useState<SessionPhaseStatus>(
    reviewState === "approved" || reviewState === "archived"
      ? "approved"
      : reviewFixture
        ? "awaiting_review"
        : "in_progress",
  );
  const [version, setVersion] = useState(reviewArtifact.version);
  const [refresh, setRefresh] = useState(0);
  const [selected, setSelected] = useState("build");
  const source =
    version === reviewArtifact.version
      ? reviewArtifact.source
      : `# Implementation complete\n\nVersion ${version} is ready for review.`;
  const paragraphStart = source.indexOf("Version");
  const timeline: StageTimelineEntry[] = stages.map((stage) => ({
    stage,
    phaseStatus: stage.slug === "build" && phaseStatus !== "approved" ? phaseStatus : null,
    status: stage.slug === "plan" || phaseStatus === "approved" ? "completed" : "current",
  }));
  return (
    <main className="mx-auto max-w-4xl space-y-6 p-5 sm:p-10">
      <h1 className="text-2xl font-semibold">Session interaction preview</h1>
      {reviewFixture ? (
        <p className="text-sm text-muted">
          Session fixture: {phaseStatus === "approved" ? "Approved" : "Editable"} ·{" "}
          {archivedAt ? "Archived" : "Unarchived"}
        </p>
      ) : null}
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
        archivedAt={archivedAt}
        initialNow={initialNow}
      />
      <SessionCompletionSummary session={{ phaseStatus, pullRequests: [] }} />
      <ArtifactPanel
        emptyText="No artifact yet."
        initialFormattedArtifact={
          version === reviewArtifact.version ? (
            <div dangerouslySetInnerHTML={{ __html: reviewArtifact.html }} />
          ) : (
            <div>
              <h2 data-review-text-start={2} data-review-text-end={25}>
                Implementation complete
              </h2>
              <p data-review-text-start={paragraphStart} data-review-text-end={source.length}>
                Version {version} is ready for review.
              </p>
            </div>
          )
        }
        initialFormattedArtifactKey={artifactBodyCacheKey("preview", "build", version, artifactId)}
        initialNow={initialNow}
        isDrafting={false}
        isAwaitingReview={phaseStatus === "awaiting_review"}
        latestArtifact={{
          id: artifactId,
          createdAt: initialNow,
          payload: source,
          stageSlug: "build",
          version,
        }}
        loadLatest={true}
        readOnlyReason={sessionReviewReadOnlyReason({ archivedAt, phaseStatus })}
        sessionId="preview"
        stageSlug="build"
      />
    </main>
  );
}
