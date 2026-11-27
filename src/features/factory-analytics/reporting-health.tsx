import "server-only";

import type { ReactNode } from "react";

import { Status, type StatusValue } from "@/components/ui/status";
import { durationLabel, timeLabel } from "@/features/factory-analytics/analytics-view-shared";
import { ProjectionControls } from "@/features/factory-overview/projection-controls";
import {
  projectionHealthSchema,
  type ProjectionHealth,
} from "@/features/factory-overview/projection-health-contracts";
import type { AuthenticatedWorkspaceContext } from "@/features/workspaces/authenticated-context";

const statuses = {
  ready: { label: "Current", value: "healthy" },
  building: { label: "Updating", value: "in_progress" },
  paused: { label: "Paused", value: "blocked" },
  failed: { label: "Failed", value: "failed" },
  unavailable: { label: "Unavailable", value: "not_started" },
} satisfies Record<ProjectionHealth["status"], { label: string; value: StatusValue }>;

const rebuildLabels = {
  idle: "No rebuild requested",
  queued: "Queued",
  building: "Rebuilding",
  completed: "Completed",
} satisfies Record<ProjectionHealth["rebuild"]["state"], string>;

export async function ReportingHealth({
  supabase,
  captureStartedAt,
  workspaceId,
  factoryId,
}: {
  supabase: AuthenticatedWorkspaceContext["supabase"];
  captureStartedAt: ReactNode;
  workspaceId: string;
  factoryId: string;
}) {
  const result = await Promise.resolve(
    supabase
      .rpc("get_factory_flow_projection_health", {
        p_workspace_id: workspaceId,
        p_factory_id: factoryId,
      })
      .abortSignal(AbortSignal.timeout(5_000)),
  ).catch(() => null);
  const health =
    result && !result.error ? projectionHealthSchema.safeParse(result.data).data : undefined;
  const status = statuses[health?.status ?? "unavailable"];
  const rebuild = health?.rebuild;
  return (
    <details>
      <summary className="cursor-pointer rounded-md px-4 py-3 marker:text-muted hover:bg-control-muted focus-visible:outline-2 focus-visible:outline-accent sm:px-5">
        <span className="ml-2 inline-flex flex-wrap items-center gap-x-3 gap-y-1 align-middle">
          <span className="type-section-title">Reporting health</span>
          <Status compact label={status.label} value={status.value} />
        </span>
      </summary>
      <div className="space-y-3 border-t border-border px-4 py-3 sm:px-5">
        <p className="type-secondary text-muted">
          Projection updates and rebuilds affect flow and delivery summaries. Sessions and outcome
          capture continue independently.
        </p>
        {!health && (
          <p className="type-secondary text-muted">
            Projection details couldn’t load. Reload this page to try again.
          </p>
        )}
        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <HealthField label="Lifecycle capture began" text={captureStartedAt} />
          <HealthField label="Projection snapshot" text={timeLabel(health?.sourceSnapshotAt)} />
          <HealthField
            label="Oldest pending observation"
            text={
              health && !health.oldestPendingAt ? "None queued" : timeLabel(health?.oldestPendingAt)
            }
          />
          <HealthField
            label="Projection lag"
            text={
              health
                ? health.lagSeconds === null
                  ? "No queued observations"
                  : durationLabel(health.lagSeconds)
                : "Unknown"
            }
          />
          <HealthField label="Rebuild" text={rebuild ? rebuildLabels[rebuild.state] : "Unknown"} />
          {rebuild?.requestedAt && (
            <HealthField label="Rebuild requested" text={timeLabel(rebuild.requestedAt)} />
          )}
          {rebuild?.completedAt && (
            <HealthField label="Rebuild completed" text={timeLabel(rebuild.completedAt)} />
          )}
          {health?.pausedAt && (
            <HealthField label="Paused since" text={timeLabel(health.pausedAt)} />
          )}
          {health?.failedAt && (
            <HealthField label="Last projection failure" text={timeLabel(health.failedAt)} />
          )}
          {health?.retryAfter && (
            <HealthField label="Next retry eligible" text={timeLabel(health.retryAfter)} />
          )}
        </dl>
        {health?.paused && rebuild?.state === "queued" && (
          <p className="type-secondary text-muted">
            The queued rebuild starts after the projection resumes.
          </p>
        )}
      </div>
      {health?.canManage && (
        <ProjectionControls
          key={`${workspaceId}:${factoryId}`}
          factoryId={factoryId}
          workspaceId={workspaceId}
          paused={health.paused}
          rebuilding={rebuild?.state === "queued" || rebuild?.state === "building"}
        />
      )}
    </details>
  );
}

function HealthField({ label, text }: { label: string; text: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="type-label text-muted">{label}</dt>
      <dd className="type-secondary break-words font-medium tabular-nums">{text}</dd>
    </div>
  );
}
