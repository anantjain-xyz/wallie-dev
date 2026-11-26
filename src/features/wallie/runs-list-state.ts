import { z } from "zod";

import { withFactoryQuery } from "@/features/factories/factory-selection";
import {
  runCatalogQuerySchema,
  type RunCatalogQuery,
} from "@/features/wallie/run-catalog-contracts";
import type { WorkspaceRunCatalogItem } from "@/features/wallie/run-catalog";
import { isWallieRunTerminalStatus } from "@/features/wallie/utils";
import { workspaceRunDetailPath, workspaceRunsPath } from "@/lib/routes";

const factoryScope = z.union([z.literal("all"), z.string().uuid()]);

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
  revision?: Pick<RunCatalogQuery, "agentId" | "agentPromptRevisionId">,
) {
  const query: Record<string, string | number | undefined> = { limit, ...revision };
  for (const key of ["status", "provider", "sessionId", "stageId"]) {
    const value = form.get(key);
    if (typeof value === "string" && value) query[key] = value;
  }
  return withFactoryQuery(workspaceRunsPath(workspaceSlug, query), factoryQuery);
}

export function runsListHasFilters(query: RunCatalogQuery) {
  return Boolean(
    query.status || query.provider || query.sessionId || query.stageId || query.agentId,
  );
}

export function runFromListHref(
  workspaceSlug: string,
  runId: string,
  query: RunCatalogQuery,
  factoryQuery?: string,
) {
  const search = new URL(
    runsListPageHref(workspaceSlug, query, query.cursor, factoryQuery),
    "http://localhost",
  ).searchParams.toString();
  const detail = workspaceRunDetailPath(workspaceSlug, runId);
  return search ? `${detail}?${new URLSearchParams({ fromRuns: search })}` : detail;
}

export function runListReturn(
  workspaceSlug: string,
  raw: string | string[] | undefined,
): { href: string; label: string } | undefined {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) return;
  const params = new URLSearchParams(raw);
  if (new Set(params.keys()).size !== params.size) return;
  const { factory, ...query } = Object.fromEntries(params);
  const scope = factoryScope.optional().safeParse(factory);
  const parsed = parseRunsListQuery(query);
  if (!scope.success || !parsed.success) return;
  return {
    href: runsListPageHref(workspaceSlug, parsed.data, parsed.data.cursor, scope.data),
    label: runsListHasFilters(parsed.data)
      ? "Back to filtered runs"
      : parsed.data.cursor
        ? "Back to older runs"
        : "Back to runs",
  };
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
  if (run.newerRunId || recovery.queue.state === "superseded") return "Newer attempt exists";
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
import { z } from "zod";
