import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { resolveSandboxImplementation } from "@/lib/sandbox";
import type { Tables } from "@/lib/supabase/database.types";
import { WALLIE_REQUIRED_SECRET_KEYS } from "@/lib/wallie/constants";
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
import { loadVercelSandboxConnectionPreview } from "@/lib/vercel-sandbox/server";

type SupabaseServerClient = Awaited<ReturnType<typeof createSupabaseServerClient>>;

export const WALLIE_RUN_PAGE_SIZE = 20;

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
    query = query.or(
      `created_at.lt.${input.cursor.createdAt},and(created_at.eq.${input.cursor.createdAt},id.lt.${input.cursor.id})`,
    );
  }

  const { data, error } = await query;

  if (error) {
    throw error;
  }

  const rows = (data ?? []) as AgentRunRow[];
  const pageRows = rows.slice(0, WALLIE_RUN_PAGE_SIZE);
  const runs = buildWallieSessionData({
    sessionGithubRepositoryId: null,
    memberIndex: input.memberIndex,
    messages: [],
    missingSecretKeys: [],
    repository: null,
    requiresVercelSandbox: false,
    runs: pageRows,
    vercelSandboxConnection: missingVercelSandboxConnection,
  }).runs;
  const lastRun = pageRows.at(-1);

  return {
    nextCursor:
      rows.length > WALLIE_RUN_PAGE_SIZE && lastRun
        ? { createdAt: lastRun.created_at, id: lastRun.id }
        : null,
    runs,
  };
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
  const secretRowsPromise =
    WALLIE_REQUIRED_SECRET_KEYS.length > 0
      ? admin
          .from("workspace_secrets")
          .select("key")
          .eq("workspace_id", input.workspaceId)
          .in("key", [...WALLIE_REQUIRED_SECRET_KEYS])
      : Promise.resolve({ data: [], error: null });
  const [
    runPage,
    { data: memberRows, error: memberError },
    { data: secretRows, error: secretError },
    vercelSandboxConnection,
  ] = await Promise.all([
    runPagePromise,
    memberRowsPromise,
    secretRowsPromise,
    loadWallieVercelSandboxConnection(admin, input.workspaceId),
  ]);

  if (memberError) {
    throw memberError;
  }

  if (secretError) {
    throw secretError;
  }

  const availableSecretKeys = new Set((secretRows ?? []).map((secret) => secret.key));
  const missingSecretKeys = [...WALLIE_REQUIRED_SECRET_KEYS].filter(
    (secretKey) => !availableSecretKeys.has(secretKey),
  );
  const members = ((memberRows ?? []) as WorkspaceMemberRow[]).map(mapWorkspaceMemberRow);
  const memberIndex = buildWorkspaceMemberIndex(members);

  return buildWallieSessionData({
    sessionGithubRepositoryId: input.session.githubRepositoryId,
    loadedMessageRunIds: [],
    memberIndex,
    messages: [],
    missingSecretKeys,
    nextRunCursor: runPage.nextCursor,
    repository: input.repository,
    requiresVercelSandbox: resolveSandboxImplementation() === "vercel",
    runs: runPage.runs.map((run) => ({
      created_at: run.createdAt,
      finished_at: run.finishedAt,
      id: run.id,
      model_name: run.modelName,
      model_provider: run.modelProvider,
      run_type: run.runType,
      stage_id: run.stageId,
      stage_name: run.stageName,
      stage_slug: run.stageSlug,
      started_at: run.startedAt,
      status: run.status,
      triggered_by_member_id: run.requestedByMemberId,
      updated_at: run.updatedAt,
    })),
    vercelSandboxConnection,
    workspaceMembers: members,
  });
}

async function loadWallieVercelSandboxConnection(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  workspaceId: string,
): Promise<WallieVercelSandboxConnectionStatus> {
  const connection = await loadVercelSandboxConnectionPreview(admin, workspaceId);

  if (!connection) {
    return {
      connected: false,
      lastValidationError: null,
      projectId: null,
      projectName: null,
      status: "missing",
      teamId: null,
    };
  }

  return {
    connected: connection.status === "connected",
    lastValidationError: connection.lastValidationError,
    projectId: connection.projectId,
    projectName: connection.projectName,
    status: connection.status,
    teamId: connection.teamId,
  };
}

const runSelect =
  "id, created_at, finished_at, model_name, model_provider, run_type, stage_id, stage_slug, stage_name, started_at, status, triggered_by_member_id, updated_at";
const memberSelect = "id, full_name, username, avatar_url, role, kind, user_id, is_active";

type AgentRunRow = Pick<
  Tables<"agent_runs">,
  | "created_at"
  | "finished_at"
  | "id"
  | "model_name"
  | "model_provider"
  | "run_type"
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
