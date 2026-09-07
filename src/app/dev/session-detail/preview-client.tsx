"use client";

import { useState, type ReactNode } from "react";
import { ArchiveIcon } from "@/components/shared/icons/archive-icon";
import { PAGE_HEADER_TITLE_CLASS, PageContainer } from "@/components/ui/page-shell";
import { SessionDetailHeader } from "@/features/sessions/detail/session-detail-header";
import { SessionCompletionSummary } from "@/features/sessions/detail/session-completion-summary";
import { SessionStageWorkspace } from "@/features/sessions/detail/session-stage-workspace";
import { StageTimeline, buildStageTimeline } from "@/features/sessions/detail/stage-timeline";
import { SessionReviewBar } from "@/features/sessions/detail/session-review-bar";
import { ArtifactPanel } from "@/features/sessions/detail/artifact-panel";
import { SessionActivityFailure } from "@/features/sessions/detail/session-activity-failure";
import {
  SessionActivityPlaceholder,
  SessionRunSurface,
  SessionRunHistory,
  SessionActivityPresentationProvider,
} from "@/features/sessions/detail/session-activity-presentation";
import { SessionRefreshContext } from "@/features/sessions/detail/session-refresh-context";
import type { SessionReviewSession } from "@/features/sessions/detail/data";
import { WallieRunCard } from "@/features/wallie/run-activity";
import type { WallieRun, WallieRunMessage } from "@/features/wallie/types";

const modes = [
  "Running",
  "Ready for review",
  "Revising",
  "Queued",
  "Failed",
  "Loading",
  "Unavailable",
  "Approved",
] as const;
type Mode = (typeof modes)[number];
const stages = [
  { description: "Plan the change", id: "plan", name: "Plan", position: 0, slug: "plan" },
  {
    description: "Implement the approved plan",
    id: "build",
    name: "Build",
    position: 1,
    slug: "build",
  },
];
export function SessionDetailPreview({
  initialNow,
  artifacts,
}: {
  initialNow: string;
  artifacts: Record<"plan" | "build", { markdown: string; rendered: ReactNode }>;
}) {
  const [mode, setMode] = useState<Mode>("Running");
  const [selected, setSelected] = useState("build");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [linear, setLinear] = useState(false);
  const [pr, setPr] = useState(false);
  const [archived, setArchived] = useState(false);
  const [historical, setHistorical] = useState(false);
  const now = Date.parse(initialNow);
  const at = (seconds: number) => new Date(now - seconds * 1000).toISOString();
  const active = ["Running", "Revising", "Queued", "Loading", "Unavailable"].includes(mode);
  const hasArtifact =
    selected === "plan" || ["Ready for review", "Revising", "Approved"].includes(mode);
  const showRun = (selected === "build" && active) || (selected === "build" && mode === "Failed");
  const phaseStatus =
    mode === "Ready for review"
      ? "awaiting_review"
      : mode === "Approved"
        ? "approved"
        : mode === "Failed"
          ? "rejected"
          : "in_progress";
  const session: SessionReviewSession = {
    id: "session-detail-preview",
    number: 37,
    title: "Improve the focus treatment on the new session prompt",
    promptMd:
      "When we start a new session, the blue outline around the Prompt box feels too prominent. Refine the default treatment while keeping keyboard focus visible.",
    createdAt: at(800),
    updatedAt: initialNow,
    archivedAt: archived ? initialNow : null,
    currentStageId: "build",
    currentStageSlug: "build",
    currentArtifactVersion: hasArtifact ? 1 : 0,
    phaseStatus,
    pipeline: { stages },
    artifacts: [],
    attachments: [],
    phaseCompletions: [{ stageId: "plan", stageSlug: "plan", completedAt: at(390) }],
    linearIssueId: linear ? "WAL-142" : null,
    linearIssueUrl: linear ? "https://linear.app/example/issue/WAL-142" : null,
    pullRequests:
      pr || mode === "Ready for review" || mode === "Approved"
        ? [
            {
              id: "preview-pr",
              pullRequestNumber: 128,
              pullRequestUrl: "https://github.com/example/app/pull/128",
            },
          ]
        : [],
  };
  const messages: WallieRunMessage[] = [
    {
      id: "text",
      createdAt: at(4),
      kind: "text",
      messageMd:
        mode === "Revising"
          ? "Applying your feedback, then checking keyboard navigation again."
          : "I’m checking focus styles and keyboard navigation in the new session dialog.",
    },
    {
      id: "tool",
      createdAt: initialNow,
      kind: "tool_use",
      messageMd: '**Tool:** bash\n\n```\n{"cmd":"pnpm check"}\n```',
    },
    ...(mode === "Failed"
      ? [
          {
            id: "error",
            createdAt: initialNow,
            kind: "error",
            messageMd:
              "The sandbox disconnected before the build finished. Retry to start another attempt.",
          },
        ]
      : []),
  ];
  const run: WallieRun = {
    id: "preview-build",
    stageId: "build",
    stageSlug: "build",
    stageName: "Build",
    attemptCount: mode === "Revising" ? 2 : 1,
    canCancel: active && !archived,
    canRetry: mode === "Failed" && !archived,
    createdAt: at(389),
    startedAt: mode === "Queued" ? null : at(389),
    finishedAt: active ? null : initialNow,
    isActive: active,
    isTerminal: !active,
    lastActivityAt: initialNow,
    updatedAt: initialNow,
    status:
      mode === "Failed" ? "error" : mode === "Queued" ? "queued" : active ? "running" : "success",
    messages: mode === "Queued" ? [] : messages,
    modelName: "gpt-5.5",
    modelProvider: "codex",
    requestedByMember: null,
    requestedByMemberId: null,
    runType: "code",
    sandboxId: "preview-sandbox",
    sandboxProvider: "vercel",
  };
  const historicalRuns: WallieRun[] = [
    {
      ...run,
      id: "preview-plan",
      stageId: "plan",
      stageSlug: "plan",
      stageName: "Plan",
      status: "success",
      isActive: false,
      isTerminal: true,
      canCancel: false,
      canRetry: false,
      attemptCount: 1,
      messages: [],
      startedAt: at(650),
      finishedAt: at(505),
    },
  ];
  const stopControl = run.canCancel ? (
    <button className="ui-button text-danger" onClick={() => setMode("Failed")} type="button">
      Stop run
    </button>
  ) : null;
  const renderRun = (value: WallieRun, primary: boolean) => (
    <WallieRunCard
      key={value.id}
      run={value}
      isPrimary={primary}
      actionPending={false}
      branchName={null}
      cancelLocked={false}
      cancelControl={primary ? stopControl : undefined}
      connectionState="live"
      isExpanded={expanded === value.id}
      messagesLoaded
      messagesLoadFailed={false}
      nowMs={now}
      renderNow={initialNow}
      stallTimeoutMs={900_000}
      onCancel={async () => setMode("Failed")}
      onRetry={async () => setMode("Queued")}
      onToggle={(id) => setExpanded((current) => (current === id ? null : id))}
      retryLocked={archived}
    />
  );
  const artifact = hasArtifact ? (
    <ArtifactPanel
      emptyText="No output"
      initialFormattedArtifact={artifacts[selected === "plan" ? "plan" : "build"].rendered}
      initialFormattedArtifactKey={`${session.id}:${selected}:1`}
      initialNow={initialNow}
      isDrafting={false}
      latestArtifact={{
        stageSlug: selected,
        version: 1,
        createdAt: initialNow,
        payload: artifacts[selected === "plan" ? "plan" : "build"].markdown,
      }}
      loadLatest
      onViewingHistoricalChange={setHistorical}
      sessionId={session.id}
      stageSlug={selected}
    />
  ) : null;
  return (
    <>
      <div
        className="mx-auto flex max-w-[1080px] flex-wrap items-center gap-4 px-4 pt-5 text-xs text-muted sm:px-8"
        data-preview-controls
      >
        <span>Development preview · illustrative content</span>
        <label className="flex items-center gap-2">
          State
          <select
            className="ui-select"
            value={mode}
            onChange={(event) => {
              setMode(event.target.value as Mode);
              setSelected("build");
            }}
          >
            {modes.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={linear}
            onChange={(event) => setLinear(event.target.checked)}
          />
          Linear linked
        </label>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={pr} onChange={(event) => setPr(event.target.checked)} />
          PR linked
        </label>
      </div>
      <PageContainer className="pb-8">
        <SessionDetailHeader
          actions={
            <button
              className="ui-button gap-1.5"
              type="button"
              onClick={() => setArchived((value) => !value)}
            >
              <ArchiveIcon className="size-3.5" />
              {archived ? "Unarchive" : "Archive"}
            </button>
          }
          creatorDisplayName="Anant Jain"
          initialNow={initialNow}
          repository={{
            fullName: "anantjain-xyz/wallie-dev",
            defaultBranch: "main",
            htmlUrl: "https://github.com/anantjain-xyz/wallie-dev",
          }}
          session={session}
          title={<h1 className={PAGE_HEADER_TITLE_CLASS}>{session.title}</h1>}
          workspaceSlug="preview"
        />
        <SessionCompletionSummary session={session} />
        <div className="mb-5">
          <StageTimeline
            timeline={buildStageTimeline(session, {
              failedStageSlug: mode === "Failed" ? "build" : null,
            })}
            selectedStageSlug={selected}
            onSelect={setSelected}
          />
        </div>
        <SessionStageWorkspace
          stageName={selected === "plan" ? "Plan" : "Build"}
          stageSlug={selected}
          focus={showRun ? "run" : "artifact"}
          emptyText="This stage has not started yet."
          artifact={artifact}
          reviewControls={
            <SessionReviewBar
              attached
              approveLabel="Approve stage"
              approveDescription="Final-stage approval may also archive the session."
              mode={
                !showRun && selected === "build" && mode === "Ready for review"
                  ? historical
                    ? {
                        kind: "historical_version",
                        reason: "Return to Latest to review this stage.",
                      }
                    : { kind: "reviewable", canApprove: true }
                  : { kind: "running" }
              }
              onApprove={() => setMode("Approved")}
              onReject={async () => {
                setMode("Revising");
                return true;
              }}
              phaseActionPending={null}
            />
          }
          activity={
            <SessionActivityPresentationProvider
              value={{ currentStage: { id: "build", name: "Build", phaseStatus }, stopControl }}
            >
              <SessionRefreshContext.Provider
                value={{ refresh: () => setMode("Running"), pending: false }}
              >
                {mode === "Loading" ? (
                  <SessionActivityPlaceholder>
                    <p className="py-3 text-sm text-muted" role="status">
                      Loading activity…
                    </p>
                  </SessionActivityPlaceholder>
                ) : mode === "Unavailable" ? (
                  <SessionActivityFailure />
                ) : (
                  <div
                    className={
                      showRun ? "space-y-5" : "divide-y divide-border border-y border-border"
                    }
                  >
                    <SessionRunSurface>{renderRun(run, true)}</SessionRunSurface>
                    <SessionRunHistory count={historicalRuns.length}>
                      <div
                        className={
                          showRun
                            ? "divide-y divide-border border-y border-border"
                            : "divide-y divide-border"
                        }
                      >
                        {historicalRuns.map((pastRun) => renderRun(pastRun, false))}
                      </div>
                    </SessionRunHistory>
                  </div>
                )}
              </SessionRefreshContext.Provider>
            </SessionActivityPresentationProvider>
          }
        />
      </PageContainer>
    </>
  );
}
