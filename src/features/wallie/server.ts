import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { resolveSandboxImplementation } from "@/lib/sandbox";
import { RECOMMENDED_AGENT_CONFIG_DEFAULTS } from "@/lib/agent-config/contracts";
import type { Tables } from "@/lib/supabase/database.types";
import { olderRunFilter, splitRunPage } from "@/features/wallie/run-pagination";
import { buildWallieSessionData } from "@/features/wallie/data";
import type {
  WallieSessionRepository,
  WallieRunCursor,
  WallieRunPage,
  WallieVercelSandboxConnectionStatus,
} from "@/features/wallie/types";
import {
  buildWorkspaceMemberIndex,
  mapWorkspaceMemberRow,
} from "@/features/workspace-members/model";
import type { WorkspaceMemberRow } from "@/features/workspace-members/types";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { loadWorkspaceSandboxOverview, providerLabel } from "@/lib/sandbox-connections/server";
import type { SandboxSettingsResponse } from "@/lib/sandbox-connections/contracts";

type SupabaseServerClient = Awaited<ReturnType<typeof createSupabaseServerClient>>;
type AdminClient = ReturnType<typeof createSupabaseAdminClient>;

export const WALLIE_RUN_PAGE_SIZE = 20;
/** PostgREST `api.max_rows` is 1000 — page so newer runs are not dropped. */
export const ATTEMPT_ORDINAL_PAGE_SIZE = 1000;

function toBuildableRunRow(row: AgentRunRow, attemptCount: number) {
  return {
    attemptCount,
    branch_name: row.branch_name,
    created_at: row.created_at,
    cost_provenance: row.cost_provenance,
    finished_at: row.finished_at,
    id: row.id,
    input_tokens: row.input_tokens,
    output_tokens: row.output_tokens,
    total_cost_usd: row.total_cost_usd,
    token_provenance: row.token_provenance,
    usage_finalized_at: row.usage_finalized_at,
    last_activity_at: row.last_activity_at,
    model_name: row.model_name,
    model_provider: row.model_provider,
    run_type: row.run_type,
    sandbox_id: row.sandbox_id,
    sandbox_provider: row.sandbox_provider,
    started_at: row.started_at,
    stage_id: row.stage_id,
    stage_name: row.stage_name,
    stage_slug: row.stage_slug,
    status: row.status,
    triggered_by_member_id: row.triggered_by_member_id,
    updated_at: row.updated_at,
  };
}

export type OrdinalRunRow = {
  created_at: string;
  id: string;
  stage_id: string | null;
};

/**
 * Assign 1-based per-stage attempt ordinals from chronological run history.
 * Keys by immutable `stage_id` so slug renames do not reset attempt ordinals.
 */
export function computeAttemptOrdinalsFromRows(rows: OrdinalRunRow[]): Map<string, number> {
  const sorted = [...rows].sort((a, b) => {
    if (a.created_at !== b.created_at) {
      return a.created_at < b.created_at ? -1 : 1;
    }
    if (a.id !== b.id) {
      return a.id < b.id ? -1 : 1;
    }
    return 0;
  });

  const ordinals = new Map<string, number>();
  const perStage = new Map<string, number>();

  for (const row of sorted) {
    // Key by immutable stage_id so slug renames (rewrite_default_pipeline) do
    // not reset attempt ordinals mid-history.
    const stageKey = row.stage_id ?? "__session__";
    const next = (perStage.get(stageKey) ?? 0) + 1;
    perStage.set(stageKey, next);
    ordinals.set(row.id, next);
  }

  return ordinals;
}

/**
 * Snapshot a stable per-run attempt ordinal from chronological stage history.
 * Do not read mutable `agent_jobs.attempt_count` — that value advances on later
 * claims and would relabel historical runs.
 */
export async function loadAttemptOrdinalForRun(sessionId: string, runId: string) {
  const ordinals = await loadAttemptOrdinalsByRunId(createSupabaseAdminClient(), sessionId);
  return ordinals.get(runId) ?? 1;
}

async function loadAttemptOrdinalsByRunId(admin: AdminClient, sessionId: string) {
  const rows: OrdinalRunRow[] = [];

  for (let offset = 0; ; offset += ATTEMPT_ORDINAL_PAGE_SIZE) {
    const { data, error } = await admin
      .from("agent_runs")
      .select("id, created_at, stage_id")
      .eq("session_id", sessionId)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(offset, offset + ATTEMPT_ORDINAL_PAGE_SIZE - 1);

    if (error) {
      throw error;
    }

    const page = data ?? [];
    rows.push(...page);
    if (page.length < ATTEMPT_ORDINAL_PAGE_SIZE) {
      break;
    }
  }

  return computeAttemptOrdinalsFromRows(rows);
}

export async function loadWallieRunPage(input: {
  cursor?: WallieRunCursor | null;
  memberIndex: ReturnType<typeof buildWorkspaceMemberIndex>;
  sessionId: string;
  supabase: SupabaseServerClient;
}): Promise<WallieRunPage> {
  let query = input.supabase
    .from("agent_runs")
    .select(runSelect)
    .eq("session_id", input.sessionId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(WALLIE_RUN_PAGE_SIZE + 1);

  if (input.cursor) {
    query = query.or(olderRunFilter(input.cursor));
  }

  let rows: AgentRunRow[];
  let attemptOrdinals: Map<string, number>;

  if (input.cursor) {
    const [{ data, error }, ordinals] = await Promise.all([
      query,
      loadAttemptOrdinalsByRunId(createSupabaseAdminClient(), input.sessionId),
    ]);
    if (error) {
      throw error;
    }
    rows = (data ?? []) as AgentRunRow[];
    attemptOrdinals = ordinals;
  } else {
    const { data, error } = await query;
    if (error) {
      throw error;
    }
    rows = (data ?? []) as AgentRunRow[];
    attemptOrdinals =
      rows.length <= WALLIE_RUN_PAGE_SIZE
        ? computeAttemptOrdinalsFromRows(rows)
        : await loadAttemptOrdinalsByRunId(createSupabaseAdminClient(), input.sessionId);
  }

  const { rows: pageRows, nextCursor } = splitRunPage(rows, WALLIE_RUN_PAGE_SIZE, (row) => ({
    createdAt: row.created_at,
    id: row.id,
  }));
  const failedRunIds = pageRows.filter((run) => run.status === "error").map((run) => run.id);
  // One fenced terminal record per run. Activity remains lazy and bounded independently.
  const failures = failedRunIds.length
    ? await input.supabase
        .from("agent_run_messages")
        .select("agent_run_id, created_at, id, kind, message_md")
        .in("agent_run_id", failedRunIds)
        .eq("kind", "run_failure")
    : { data: [], error: null };
  if (failures.error) throw failures.error;
  const runs = buildWallieSessionData({
    sessionGithubRepositoryId: null,
    memberIndex: input.memberIndex,
    messages: failures.data ?? [],
    loadedMessageRunIds: [],
    repository: null,
    requiresVercelSandbox: false,
    runs: pageRows.map((row) => toBuildableRunRow(row, attemptOrdinals.get(row.id) ?? 1)),
    vercelSandboxConnection: missingVercelSandboxConnection,
  }).runs;
  return { nextCursor, runs };
}

export async function loadWallieSessionData(input: {
  session: { githubRepositoryId: string | null; id: string };
  repository: WallieSessionRepository | null;
  supabase: SupabaseServerClient;
  workspaceId: string;
}) {
  const admin = createSupabaseAdminClient();
  const runPagePromise = loadWallieRunPage({
    memberIndex: new Map(),
    sessionId: input.session.id,
    supabase: input.supabase,
  });
  const memberRowsPromise = input.supabase
    .from("workspace_members")
    .select(memberSelect)
    .eq("workspace_id", input.workspaceId);
  const [
    runPage,
    { data: memberRows, error: memberError },
    vercelSandboxConnection,
    stallTimeoutMs,
  ] = await Promise.all([
    runPagePromise,
    memberRowsPromise,
    loadWallieVercelSandboxConnection(admin, input.workspaceId),
    loadWallieStallTimeoutMs(admin, input.workspaceId),
  ]);

  if (memberError) {
    throw memberError;
  }

  const members = ((memberRows ?? []) as WorkspaceMemberRow[]).map(mapWorkspaceMemberRow);
  const memberIndex = buildWorkspaceMemberIndex(members);

  return buildWallieSessionData({
    sessionGithubRepositoryId: input.session.githubRepositoryId,
    loadedMessageRunIds: [],
    memberIndex,
    messages: [],
    nextRunCursor: runPage.nextCursor,
    repository: input.repository,
    requiresVercelSandbox: resolveSandboxImplementation() !== "fake",
    runs: runPage.runs.map((run) => ({
      attemptCount: run.attemptCount,
      branch_name: run.branchName,
      created_at: run.createdAt,
      cost_provenance: run.usage.costProvenance,
      finished_at: run.finishedAt,
      failure: run.failure,
      id: run.id,
      input_tokens: run.usage.inputTokens,
      output_tokens: run.usage.outputTokens,
      total_cost_usd: run.usage.totalCostUsd,
      token_provenance: run.usage.tokenProvenance,
      usage_finalized_at: run.usage.finalized ? (run.finishedAt ?? run.updatedAt) : null,
      last_activity_at: run.lastActivityAt,
      model_name: run.modelName,
      model_provider: run.modelProvider,
      run_type: run.runType,
      sandbox_id: run.sandboxId,
      sandbox_provider: run.sandboxProvider,
      stage_id: run.stageId,
      stage_name: run.stageName,
      stage_slug: run.stageSlug,
      started_at: run.startedAt,
      status: run.status,
      triggered_by_member_id: run.requestedByMemberId,
      updated_at: run.updatedAt,
    })),
    stallTimeoutMs,
    vercelSandboxConnection,
    workspaceMembers: members,
  });
}

async function loadWallieVercelSandboxConnection(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  workspaceId: string,
): Promise<WallieVercelSandboxConnectionStatus> {
  const overview = await loadWorkspaceSandboxOverview(admin, workspaceId);
  return mapWallieSandboxConnectionStatus(overview);
}

export function mapWallieSandboxConnectionStatus(
  overview: SandboxSettingsResponse,
): WallieVercelSandboxConnectionStatus {
  const provider = overview.activeProvider;
  const connection = overview.connections[provider];

  if (!overview.enabledProviders.includes(provider)) {
    return {
      connected: false,
      connectionRevision: connection ? String(connection.connectionRevision) : null,
      displayName: null,
      lastValidationError: `${providerLabel(provider)} is disabled in this Wallie deployment. Switch to an enabled sandbox provider.`,
      provider,
      providerLabel: providerLabel(provider),
      projectId: null,
      projectName: null,
      status: "error",
      teamId: null,
    };
  }

  if (!connection) {
    return {
      connected: false,
      connectionRevision: null,
      displayName: null,
      lastValidationError: null,
      provider,
      providerLabel: providerLabel(provider),
      projectId: null,
      projectName: null,
      status: "missing",
      teamId: null,
    };
  }

  const vercel = provider === "vercel" ? overview.connections.vercel : null;
  return {
    connected: connection.status === "connected",
    connectionRevision: String(connection.connectionRevision),
    displayName:
      provider === "vercel"
        ? (vercel?.projectName ?? vercel?.projectId ?? null)
        : provider === "e2b"
          ? (overview.connections.e2b?.apiKeyPreview ?? null)
          : (overview.connections.daytona?.target ?? overview.connections.daytona?.apiUrl ?? null),
    lastValidationError: connection.lastValidationError,
    provider,
    providerLabel: providerLabel(provider),
    projectId: vercel?.projectId ?? null,
    projectName: vercel?.projectName ?? null,
    status: connection.status,
    teamId: vercel?.teamId ?? null,
  };
}

async function loadWallieStallTimeoutMs(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  workspaceId: string,
): Promise<number> {
  const { data, error } = await admin
    .from("workspace_agent_config")
    .select("value_json")
    .eq("workspace_id", workspaceId)
    .eq("key", "stall_timeout_ms")
    .maybeSingle();

  if (error || typeof data?.value_json !== "number" || !Number.isFinite(data.value_json)) {
    return RECOMMENDED_AGENT_CONFIG_DEFAULTS.stall_timeout_ms;
  }

  return data.value_json;
}

// Authenticated users can SELECT agent_runs. Do not join agent_jobs — that
// table is service-role only and would fail the entire activity load under RLS.
const runSelect =
  "id, branch_name, created_at, cost_provenance, finished_at, input_tokens, output_tokens, total_cost_usd, token_provenance, usage_finalized_at, last_activity_at, model_name, model_provider, run_type, sandbox_id, sandbox_provider, stage_id, stage_slug, stage_name, started_at, status, triggered_by_member_id, updated_at";
const memberSelect = "id, full_name, username, avatar_url, role, kind, user_id, is_active";

type AgentRunRow = Pick<
  Tables<"agent_runs">,
  | "branch_name"
  | "created_at"
  | "cost_provenance"
  | "finished_at"
  | "id"
  | "input_tokens"
  | "output_tokens"
  | "total_cost_usd"
  | "token_provenance"
  | "usage_finalized_at"
  | "last_activity_at"
  | "model_name"
  | "model_provider"
  | "run_type"
  | "sandbox_id"
  | "sandbox_provider"
  | "started_at"
  | "stage_id"
  | "stage_name"
  | "stage_slug"
  | "status"
  | "triggered_by_member_id"
  | "updated_at"
>;

const missingVercelSandboxConnection: WallieVercelSandboxConnectionStatus = {
  connected: false,
  lastValidationError: null,
  projectId: null,
  projectName: null,
  status: "missing",
  teamId: null,
};
