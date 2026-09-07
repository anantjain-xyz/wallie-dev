"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

import { useChangeMotion } from "@/components/ui/use-change-motion";
import { RealtimeRecoveryProvider } from "@/features/wallie/realtime-recovery-context";
import { LiveConnectionNotice } from "@/features/wallie/live-connection-notice";
import { TimeDisplay } from "@/components/shared/time-display";
import type { SessionPhaseStatus } from "@/features/sessions/types";
import type { WallieRun } from "@/features/wallie/types";
import {
  currentOperationLabel,
  isRunActivityStalled,
  lastActivityTimestamp,
  type WallieRealtimeConnectionState,
} from "@/features/wallie/activity-summary";

type ExecutionSnapshot = {
  sessionId: string;
  run: Pick<
    WallieRun,
    "stageId" | "status" | "createdAt" | "startedAt" | "lastActivityAt" | "updatedAt" | "isActive"
  > | null;
  connection: WallieRealtimeConnectionState;
  stalled: boolean;
  retryConnection?: () => void;
  activity?: string;
};
type PublishedExecution = ExecutionSnapshot | { unavailable: true } | null;
const SnapshotContext = createContext<PublishedExecution>(null);
const PublishContext = createContext<((snapshot: PublishedExecution) => void) | null>(null);

export function SessionExecutionProvider({ children }: { children: ReactNode }) {
  const [snapshot, publish] = useState<PublishedExecution>(null);
  return (
    <RealtimeRecoveryProvider>
      <PublishContext value={publish}>
        <SnapshotContext value={snapshot}>{children}</SnapshotContext>
      </PublishContext>
    </RealtimeRecoveryProvider>
  );
}

export function usePublishExecutionUnavailable() {
  const publish = useContext(PublishContext);
  useEffect(() => {
    publish?.({ unavailable: true });
    return () => publish?.(null);
  }, [publish]);
}

/** Publish the existing live history state; no extra queries or subscriptions. */
export function usePublishExecution({
  sessionId,
  run,
  connection,
  nowMs,
  stallTimeoutMs,
  retryConnection,
}: {
  sessionId: string;
  run: WallieRun | undefined;
  connection: WallieRealtimeConnectionState;
  nowMs: number;
  stallTimeoutMs: number;
  retryConnection?: () => void;
}) {
  const publish = useContext(PublishContext);
  const stalled = run ? isRunActivityStalled({ ...run, nowMs, stallTimeoutMs }) : false;
  useEffect(() => {
    publish?.({
      sessionId,
      run: run
        ? {
            stageId: run.stageId,
            status: run.status,
            createdAt: run.createdAt,
            startedAt: run.startedAt,
            lastActivityAt: lastActivityTimestamp(run),
            updatedAt: run.updatedAt,
            isActive: run.isActive,
          }
        : null,
      connection,
      retryConnection,
      stalled,
      activity: run ? currentOperationLabel({ run, stalled }) : undefined,
    });
  }, [publish, sessionId, run, connection, stalled, retryConnection]);
  useEffect(() => () => publish?.(null), [publish, sessionId]);
}

export function executionStateLabel(
  phaseStatus: SessionPhaseStatus,
  snapshot: ExecutionSnapshot | null,
  stageId: string,
) {
  if (phaseStatus === "awaiting_review") return "Ready for your review";
  if (phaseStatus === "approved") return "Stage approved";
  const run = snapshot?.run?.stageId === stageId ? snapshot.run : null;
  if (run?.status === "canceled") return "Run canceled";
  if (phaseStatus === "rejected" && !run?.isActive)
    return run?.status === "error" ? "Run failed" : "Changes requested";
  if (!snapshot) return "Loading run status…";
  if (!run) return "Waiting for a run";
  if (run.status === "queued") return "Queued";
  if (!run.isActive) return "Waiting for the stage to update";
  if (snapshot.stalled) return "No recent activity";
  if (run.status === "started") return "Starting the run";
  return "Run in progress";
}

export function SessionExecutionSummary({
  sessionId,
  stageId,
  stageName,
  phaseStatus,
  archivedAt,
  initialNow,
}: {
  sessionId: string;
  stageId: string;
  stageName: string;
  phaseStatus: SessionPhaseStatus;
  archivedAt: string | null;
  initialNow: string;
}) {
  const published = useContext(SnapshotContext);
  const unavailable = published !== null && "unavailable" in published;
  const snapshot =
    published && "sessionId" in published && published.sessionId === sessionId ? published : null;
  const title =
    unavailable && phaseStatus === "in_progress"
      ? "Run status unavailable"
      : executionStateLabel(phaseStatus, snapshot, stageId);
  const motionRef = useChangeMotion<HTMLElement>(
    !snapshot && !unavailable && phaseStatus === "in_progress"
      ? null
      : `${sessionId}:${stageId}:${phaseStatus}:${title}:${Boolean(archivedAt)}`,
  );
  if (archivedAt || phaseStatus === "approved") return null;
  const run = snapshot?.run?.stageId === stageId ? snapshot.run : null;
  const description =
    phaseStatus === "awaiting_review"
      ? "Review the artifact below to approve it or request changes."
      : phaseStatus === "rejected" && !run?.isActive
        ? "Check the latest run and feedback for the next step."
        : run?.status === "queued"
          ? "The worker has not started this run yet."
          : run?.isActive && snapshot?.activity
            ? snapshot.activity
            : "Follow the latest run for execution details and recovery actions.";
  return (
    <section
      ref={motionRef}
      aria-label="Current execution"
      className="mb-4 rounded-[6px] border border-border bg-sheet px-4 py-3"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-foreground" role="status">
            {stageName} · {title}
          </p>
          <p className="mt-1 text-sm text-muted">{description}</p>
        </div>
        <a className="ui-button shrink-0" href="#session-runs-heading">
          View run history
        </a>
      </div>
      {run?.isActive ? (
        <p className="mt-2 text-xs text-muted">
          {run.status === "queued" ? "Queued for " : "Elapsed "}
          <TimeDisplay
            active
            variant="elapsed"
            initialNow={initialNow}
            value={run.startedAt ?? run.createdAt}
          />
        </p>
      ) : null}
      {run?.isActive && run.lastActivityAt ? (
        <p className="mt-2 text-xs text-muted">
          Last activity{" "}
          <TimeDisplay
            active
            variant="relative"
            initialNow={initialNow}
            value={run.lastActivityAt}
          />
        </p>
      ) : null}
      {snapshot ? (
        <LiveConnectionNotice state={snapshot.connection} onRetry={snapshot.retryConnection} />
      ) : null}
    </section>
  );
}
