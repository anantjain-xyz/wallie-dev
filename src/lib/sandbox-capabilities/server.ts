import "server-only";

import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { mintSandboxRepositoryToken } from "@/features/github/sandbox-token";
import { loadWorkspaceAgentConfig } from "@/lib/agent-runner";
import { getClaudeCodeCredentialForUser } from "@/lib/claude-code/tokens";
import { getCodexCredentialForUser } from "@/lib/codex/tokens";
import { getCursorCredentialForUser } from "@/lib/cursor/tokens";
import { getOpenCodeAuthForUser } from "@/lib/opencode/tokens";
import { createSessionSandbox } from "@/lib/sandbox";
import { sandboxFailureText } from "@/lib/vercel-sandbox/errors";
import { createWorkspaceSessionSandbox } from "@/lib/workspaces/resource-operations";
import type { AgentProvider, SandboxConnection, SandboxProvider } from "@/lib/sandbox/types";
import { loadRequiredWorkspaceSandboxConnection } from "@/lib/sandbox-connections/server";
import type { Database, TablesUpdate } from "@/lib/supabase/database.types";
import {
  capabilityReportSucceeded,
  probeSandboxCapabilities,
} from "@/lib/sandbox-capabilities/probe";
import type {
  SandboxCapabilityCheckState,
  SandboxCapabilityReport,
} from "@/lib/sandbox-capabilities/contracts";

type AdminClient = SupabaseClient<Database>;

type RepositoryRow = {
  default_branch: string | null;
  full_name: string;
  github_installation_id: string;
  id: string;
  workspace_id: string;
};

type StartedSandboxCapabilityCheck = {
  check: SandboxCapabilityCheckState;
  repository: RepositoryRow;
};

export type FactoryCapabilityCandidate = {
  definitionDigest: string;
  executionIdentity: "human" | "service-principal";
  sandboxProvider: SandboxProvider;
  agent: { provider: AgentProvider; model: string };
};

type FactoryCapabilityReservation = FactoryCapabilityCandidate & {
  connectionRevision: string | null;
};
type FactoryCapabilityScope = FactoryCapabilityReservation & {
  workspaceId: string;
  repositoryId: string;
};

const checkColumns =
  "id, github_repository_id, status, capabilities, error_text, checked_at, agent_provider, agent_model, sandbox_provider, sandbox_connection_revision, sandbox_vercel_team_id, sandbox_vercel_project_id";

function mapCheckRow(row: Record<string, unknown>): SandboxCapabilityCheckState {
  return {
    agentModel: typeof row.agent_model === "string" ? row.agent_model : null,
    agentProvider: typeof row.agent_provider === "string" ? row.agent_provider : null,
    capabilities:
      typeof row.capabilities === "object" && row.capabilities !== null
        ? (row.capabilities as SandboxCapabilityCheckState["capabilities"])
        : {},
    checkedAt: typeof row.checked_at === "string" ? row.checked_at : new Date().toISOString(),
    errorText: typeof row.error_text === "string" ? row.error_text : null,
    githubRepositoryId:
      typeof row.github_repository_id === "string" ? row.github_repository_id : null,
    id: typeof row.id === "string" ? row.id : null,
    sandboxConnectionRevision:
      typeof row.sandbox_connection_revision === "string" ? row.sandbox_connection_revision : null,
    sandboxProvider:
      row.sandbox_provider === "vercel" ||
      row.sandbox_provider === "e2b" ||
      row.sandbox_provider === "daytona" ||
      row.sandbox_provider === "fake"
        ? row.sandbox_provider
        : null,
    sandboxVercelProjectId:
      typeof row.sandbox_vercel_project_id === "string" ? row.sandbox_vercel_project_id : null,
    sandboxVercelTeamId:
      typeof row.sandbox_vercel_team_id === "string" ? row.sandbox_vercel_team_id : null,
    status:
      row.status === "success" || row.status === "error" || row.status === "running"
        ? row.status
        : "error",
  };
}

async function loadRepositoryForCapabilityCheck(input: {
  admin: AdminClient;
  repositoryId?: string;
  workspaceId: string;
}): Promise<RepositoryRow> {
  let query = input.admin
    .from("github_repositories")
    .select("id, workspace_id, github_installation_id, full_name, default_branch")
    .eq("workspace_id", input.workspaceId)
    .eq("is_archived", false)
    .order("full_name", { ascending: true })
    .limit(1);

  if (input.repositoryId) {
    query = input.admin
      .from("github_repositories")
      .select("id, workspace_id, github_installation_id, full_name, default_branch")
      .eq("workspace_id", input.workspaceId)
      .eq("id", input.repositoryId)
      .eq("is_archived", false)
      .limit(1);
  }

  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  if (!data)
    throw new Error(
      "Connect a non-archived GitHub repository before running a sandbox capability check.",
    );
  return data as RepositoryRow;
}

async function mintInstallationToken(
  admin: AdminClient,
  repository: RepositoryRow,
): Promise<string> {
  const { data: installation, error } = await admin
    .from("github_installations")
    .select("installation_id")
    .eq("id", repository.github_installation_id)
    .eq("workspace_id", repository.workspace_id)
    .maybeSingle();

  if (error) throw error;
  if (!installation) throw new Error("GitHub installation not found for repository.");

  return mintSandboxRepositoryToken({
    installationId: installation.installation_id,
    repositoryFullName: repository.full_name,
    purpose: "capability-check",
  });
}

async function insertRunningCheck(input: {
  admin: AdminClient;
  repositoryId: string;
  workspaceId: string;
  candidate?: FactoryCapabilityCandidate & { actorUserId: string };
}): Promise<SandboxCapabilityCheckState> {
  const scope = {
    target_github_repository_id: input.repositoryId,
    target_workspace_id: input.workspaceId,
  };
  const { candidate } = input;
  const { data, error } = candidate
    ? await input.admin.rpc("start_factory_definition_capability_check", {
        ...scope,
        target_actor_user_id: candidate.actorUserId,
        target_sandbox_provider: candidate.sandboxProvider,
        target_agent_provider: candidate.agent.provider,
        target_agent_model: candidate.agent.model,
        target_definition_digest: candidate.definitionDigest,
      })
    : await input.admin.rpc("start_sandbox_capability_check", scope);

  if (error) throw error;
  return mapCheckRow(data);
}

function updateReservedCheck(input: {
  admin: AdminClient;
  checkId: string;
  patch: TablesUpdate<"sandbox_capability_checks">;
  candidate?: FactoryCapabilityScope;
  requireRunning?: boolean;
}) {
  const query = input.admin
    .from("sandbox_capability_checks")
    .update(input.patch)
    .eq("id", input.checkId);
  const { candidate } = input;
  if (input.requireRunning || candidate) query.eq("status", "running");
  if (!candidate) return query.is("factory_definition_digest", null);

  query
    .eq("workspace_id", candidate.workspaceId)
    .eq("github_repository_id", candidate.repositoryId)
    .eq("factory_definition_digest", candidate.definitionDigest)
    .eq("sandbox_provider", candidate.sandboxProvider)
    .eq("agent_provider", candidate.agent.provider)
    .eq("agent_model", candidate.agent.model);
  return candidate.connectionRevision === null
    ? query.is("sandbox_connection_revision", null)
    : query.eq("sandbox_connection_revision", candidate.connectionRevision);
}

async function updateCheck(input: {
  admin: AdminClient;
  capabilities: Partial<SandboxCapabilityReport>;
  checkId: string | null;
  errorText: string | null;
  status: "success" | "error";
  candidate?: FactoryCapabilityScope;
}): Promise<SandboxCapabilityCheckState> {
  if (!input.checkId) {
    return {
      capabilities: {},
      agentModel: null,
      agentProvider: null,
      checkedAt: new Date().toISOString(),
      errorText: input.errorText,
      githubRepositoryId: null,
      id: null,
      sandboxProvider: null,
      sandboxConnectionRevision: null,
      sandboxVercelProjectId: null,
      sandboxVercelTeamId: null,
      status: input.status,
    };
  }

  const { data, error } = await updateReservedCheck({
    admin: input.admin,
    checkId: input.checkId,
    candidate: input.candidate,
    patch: {
      capabilities: input.capabilities,
      checked_at: new Date().toISOString(),
      error_text: input.errorText,
      status: input.status,
    },
  })
    .select(checkColumns)
    .single();

  if (error) throw error;
  return mapCheckRow(data);
}

async function updateCheckSandbox(input: {
  admin: AdminClient;
  agentModel: string;
  agentProvider: AgentProvider;
  checkId: string | null;
  connection: SandboxConnection;
  sandboxId: string;
  candidate?: FactoryCapabilityScope;
}): Promise<void> {
  if (!input.checkId) throw new Error("Sandbox capability check reservation is required.");

  const vercel = input.connection.provider === "vercel" ? input.connection.credentials : null;
  const { data, error } = await updateReservedCheck({
    admin: input.admin,
    checkId: input.checkId,
    candidate: input.candidate,
    requireRunning: true,
    patch: {
      agent_model: input.agentModel,
      agent_provider: input.agentProvider,
      sandbox_id: input.sandboxId,
      sandbox_connection_revision: input.connection.revision,
      sandbox_provider: input.connection.provider,
      sandbox_vercel_project_id: vercel?.projectId ?? null,
      sandbox_vercel_team_id: vercel?.teamId ?? null,
    },
  })
    .select("id")
    .single();

  if (error) throw error;
  if (!data) throw new Error("Sandbox capability check reservation was lost.");
}

export async function startSandboxCapabilityCheck(input: {
  admin: AdminClient;
  repositoryId?: string;
  workspaceId: string;
  candidate?: FactoryCapabilityCandidate & { actorUserId: string };
}): Promise<StartedSandboxCapabilityCheck> {
  const repository = await loadRepositoryForCapabilityCheck(input);
  const check = await insertRunningCheck({
    admin: input.admin,
    repositoryId: repository.id,
    workspaceId: input.workspaceId,
    candidate: input.candidate,
  });

  return { check, repository };
}

export async function getLatestSandboxCapabilityCheck(input: {
  admin: AdminClient;
  repositoryId: string;
  workspaceId: string;
  definitionDigest?: string;
}): Promise<SandboxCapabilityCheckState | null> {
  const query = input.admin
    .from("sandbox_capability_checks")
    .select(checkColumns)
    .eq("workspace_id", input.workspaceId)
    .eq("github_repository_id", input.repositoryId);
  if (input.definitionDigest === undefined) query.is("factory_definition_digest", null);
  else query.eq("factory_definition_digest", input.definitionDigest);
  const { data, error } = await query
    .order("checked_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data ? mapCheckRow(data) : null;
}

export async function completeSandboxCapabilityCheck(input: {
  admin: AdminClient;
  checkId: string | null;
  repository: RepositoryRow;
  userId: string;
  workspaceId: string;
  candidate?: FactoryCapabilityReservation;
}): Promise<SandboxCapabilityCheckState> {
  let sandbox = null as Awaited<ReturnType<typeof createSessionSandbox>> | null;
  const { candidate } = input;
  const candidateScope = candidate && {
    ...candidate,
    workspaceId: input.workspaceId,
    repositoryId: input.repository.id,
  };

  try {
    if (!input.checkId) throw new Error("Sandbox capability check reservation is required.");
    const { provider, model } =
      candidate?.agent ?? (await loadWorkspaceAgentConfig(input.admin, input.workspaceId));
    const sandboxSelection = candidate
      ? await loadRequiredWorkspaceSandboxConnection(
          input.admin,
          input.workspaceId,
          candidate.sandboxProvider,
        )
      : await loadRequiredWorkspaceSandboxConnection(input.admin, input.workspaceId);
    if (
      candidate &&
      (sandboxSelection.provider !== candidate.sandboxProvider ||
        sandboxSelection.connection.revision !== candidate.connectionRevision)
    ) {
      throw new Error(
        "The sandbox connection changed after this factory check was reserved. Run a new check.",
      );
    }
    const installationToken = await mintInstallationToken(input.admin, input.repository);
    if (candidate?.executionIdentity !== "service-principal") {
      if (provider === "codex") {
        await getCodexCredentialForUser(input.admin, input.userId);
      } else if (provider === "cursor") {
        await getCursorCredentialForUser(input.admin, input.userId);
      } else if (provider === "opencode") {
        await getOpenCodeAuthForUser(input.admin, input.userId, model);
      } else {
        await getClaudeCodeCredentialForUser(input.admin, input.userId);
      }
    }

    sandbox = await createWorkspaceSessionSandbox(input.admin, {
      agentProvider: provider,
      baseBranch: input.repository.default_branch ?? "main",
      branch: `wallie/capability-check-${randomUUID().slice(0, 8)}`,
      implementation: sandboxSelection.provider,
      connection: sandboxSelection.connection,
      installationToken,
      ownerId: input.checkId ?? undefined,
      repoFullName: input.repository.full_name,
      sessionId: randomUUID(),
      timeoutMs: 30 * 60_000,
      workspaceId: input.workspaceId,
      onSandboxCreated: async ({ sandboxId }) => {
        await updateCheckSandbox({
          admin: input.admin,
          agentModel: model,
          agentProvider: provider,
          checkId: input.checkId,
          connection: sandboxSelection.connection,
          sandboxId,
          candidate: candidateScope,
        });
      },
    });
    console.info("[sandbox-capability-check] sandbox started", {
      agentProvider: provider,
      sandboxProvider: sandboxSelection.provider,
      sandboxId: sandbox.id,
      workspaceId: input.workspaceId,
    });

    const capabilities = await probeSandboxCapabilities({
      agentProvider: provider,
      sandbox,
      sandboxProvider: sandboxSelection.provider,
    });
    const success = capabilityReportSucceeded(capabilities, sandboxSelection.provider, provider);
    return await updateCheck({
      admin: input.admin,
      capabilities,
      checkId: input.checkId,
      errorText: success ? null : "One or more sandbox capabilities failed.",
      status: success ? "success" : "error",
      candidate: candidateScope,
    });
  } catch (error) {
    return await updateCheck({
      admin: input.admin,
      capabilities: {},
      checkId: input.checkId,
      errorText: sandboxFailureText(error),
      status: "error",
      candidate: candidateScope,
    });
  } finally {
    await sandbox?.stop();
  }
}
