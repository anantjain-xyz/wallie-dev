import { withFactoryQuery } from "@/features/factories/factory-selection";
import {
  runCatalogQuerySchema,
  type RunCatalogQuery,
} from "@/features/wallie/run-catalog-contracts";
import type { WorkspaceRunCatalogItem } from "@/features/wallie/run-catalog";
import { isWallieRunTerminalStatus } from "@/features/wallie/utils";
import { workspaceRunsPath } from "@/lib/routes";

export type RunsListSearchParams = Record<string, string | string[] | undefined>;

export function parseRunsListQuery(searchParams: RunsListSearchParams) {
  return runCatalogQuerySchema.safeParse(
    Object.fromEntries(
      Object.entries(searchParams).filter(([, value]) => value !== undefined && value !== ""),
    ),
  );
}

export function runsListPageHref(
  workspaceSlug: string,
  query: RunCatalogQuery,
  cursor?: string,
  factoryQuery?: string,
) {
  return withFactoryQuery(workspaceRunsPath(workspaceSlug, { ...query, cursor }), factoryQuery);
}

export function runsListFilterHref(
  workspaceSlug: string,
  form: FormData,
  limit?: number,
  factoryQuery?: string,
) {
  const query: Record<string, string | number | undefined> = { limit };
  for (const key of ["status", "provider", "sessionId", "stageId"]) {
    const value = form.get(key);
    if (typeof value === "string" && value) query[key] = value;
  }
  return withFactoryQuery(workspaceRunsPath(workspaceSlug, query), factoryQuery);
}

export function runsListHasFilters(query: RunCatalogQuery) {
  return Boolean(query.status || query.provider || query.sessionId || query.stageId);
}

export function runCatalogActivityLabel(run: WorkspaceRunCatalogItem) {
  if (run.transcript.expiredAt) return "Transcript expired";
  if (run.transcript.hasEvents) {
    if (run.transcript.captureInterrupted) return "Capture interrupted";
    if (!run.transcript.captureEnded && isWallieRunTerminalStatus(run.status)) {
      return "Capture incomplete";
    }
    return "Structured activity";
  }
  return isWallieRunTerminalStatus(run.status) ? "Activity unavailable" : "No activity yet";
}

export function runCatalogRecoveryLabel(run: WorkspaceRunCatalogItem): string | null {
  const recovery = run.recovery;
  if (!recovery) return null;
  if (recovery.sourceRecoveryRequired) return "Source recovery needed";
  if (recovery.publication?.status === "pending" || recovery.publication?.status === "claimed") {
    return recovery.publication.deadlineExpired
      ? "Publication recovery expired"
      : "Recovering publication";
  }
  if (recovery.queue.state === "retry_scheduled") return "Retry scheduled";
  if (recovery.queue.state === "superseded") return "Newer attempt exists";
  if (run.status !== "started" && run.status !== "running") return null;
  if (recovery.worker.state === "deadline_expired") return "Worker deadline exceeded";
  if (recovery.activity.state === "stale") return "No recent activity";
  return null;
}

export function runCatalogCostLabel(run: WorkspaceRunCatalogItem) {
  const { totalCostUsd, costProvenance } = run.usage;
  if (totalCostUsd === null || costProvenance === "unavailable") return "Cost unavailable";
  const amount = totalCostUsd.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
  return costProvenance === "estimated" ? `${amount} estimated` : `${amount} measured`;
}

export const RUN_PROVIDER_LABELS: Record<string, string> = {
  codex: "Codex",
  "claude-code": "Claude Code",
  cursor: "Cursor",
  opencode: "OpenCode",
};
