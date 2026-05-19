import "server-only";

import { randomUUID } from "node:crypto";

import { App } from "@octokit/app";
import type { SupabaseClient } from "@supabase/supabase-js";

import { resolveGitHubAppConfig } from "@/features/github/config";
import { loadWorkspaceAgentConfig } from "@/lib/agent-runner";
import { getClaudeCodeCredentialForUser } from "@/lib/claude-code/tokens";
import { getCodexCredentialForUser } from "@/lib/codex/tokens";
import { createSessionSandbox } from "@/lib/sandbox";
import type { AgentProvider } from "@/lib/sandbox/types";
import { asLooseSupabaseClient } from "@/lib/supabase/loose";
import type { Database } from "@/lib/supabase/database.types";
import {
  capabilityReportSucceeded,
  probeSandboxCapabilities,
} from "@/lib/sandbox-capabilities/probe";
import type { SandboxCapabilityCheckState } from "@/lib/sandbox-capabilities/contracts";

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

function mapCheckRow(row: Record<string, unknown>): SandboxCapabilityCheckState {
  return {
    capabilities:
      typeof row.capabilities === "object" && row.capabilities !== null
        ? (row.capabilities as SandboxCapabilityCheckState["capabilities"])
        : {},
    checkedAt: typeof row.checked_at === "string" ? row.checked_at : new Date().toISOString(),
    errorText: typeof row.error_text === "string" ? row.error_text : null,
    githubRepositoryId:
      typeof row.github_repository_id === "string" ? row.github_repository_id : null,
    id: typeof row.id === "string" ? row.id : null,
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

  const app = new App(resolveGitHubAppConfig());
  const { data } = await app.octokit.request(
    "POST /app/installations/{installation_id}/access_tokens",
    { installation_id: installation.installation_id },
  );
  return data.token;
}

async function insertRunningCheck(input: {
  admin: AdminClient;
  repositoryId: string;
  workspaceId: string;
}): Promise<SandboxCapabilityCheckState> {
  const loose = asLooseSupabaseClient(input.admin);
  const { data, error } = await loose
    .from("sandbox_capability_checks")
    .insert({
      capabilities: {},
      github_repository_id: input.repositoryId,
      status: "running",
      workspace_id: input.workspaceId,
    })
    .select("id, github_repository_id, status, capabilities, error_text, checked_at")
    .single();

  if (error) throw error;
  return mapCheckRow(data);
}

async function updateCheck(input: {
  admin: AdminClient;
  capabilities: unknown;
  checkId: string | null;
  errorText: string | null;
  status: "success" | "error";
}): Promise<SandboxCapabilityCheckState> {
  if (!input.checkId) {
    return {
      capabilities: {},
      checkedAt: new Date().toISOString(),
      errorText: input.errorText,
      githubRepositoryId: null,
      id: null,
      status: input.status,
    };
  }

  const loose = asLooseSupabaseClient(input.admin);
  const { data, error } = await loose
    .from("sandbox_capability_checks")
    .update({
      capabilities: input.capabilities,
      checked_at: new Date().toISOString(),
      error_text: input.errorText,
      status: input.status,
    })
    .eq("id", input.checkId)
    .select("id, github_repository_id, status, capabilities, error_text, checked_at")
    .single();

  if (error) throw error;
  return mapCheckRow(data);
}

export async function runAndRecordSandboxCapabilityCheck(input: {
  admin: AdminClient;
  repositoryId?: string;
  userId: string;
  workspaceId: string;
}): Promise<SandboxCapabilityCheckState> {
  const started = await startSandboxCapabilityCheck(input);
  return completeSandboxCapabilityCheck({
    admin: input.admin,
    checkId: started.check.id,
    repository: started.repository,
    userId: input.userId,
    workspaceId: input.workspaceId,
  });
}

export async function startSandboxCapabilityCheck(input: {
  admin: AdminClient;
  repositoryId?: string;
  workspaceId: string;
}): Promise<StartedSandboxCapabilityCheck> {
  const repository = await loadRepositoryForCapabilityCheck(input);
  const check = await insertRunningCheck({
    admin: input.admin,
    repositoryId: repository.id,
    workspaceId: input.workspaceId,
  });

  return { check, repository };
}

export async function getLatestSandboxCapabilityCheck(input: {
  admin: AdminClient;
  repositoryId: string;
  workspaceId: string;
}): Promise<SandboxCapabilityCheckState | null> {
  const loose = asLooseSupabaseClient(input.admin);
  const { data, error } = await loose
    .from("sandbox_capability_checks")
    .select("id, github_repository_id, status, capabilities, error_text, checked_at")
    .eq("workspace_id", input.workspaceId)
    .eq("github_repository_id", input.repositoryId)
    .order("checked_at", { ascending: false })
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
}): Promise<SandboxCapabilityCheckState> {
  let sandbox = null as Awaited<ReturnType<typeof createSessionSandbox>> | null;

  try {
    const agentConfig = await loadWorkspaceAgentConfig(input.admin, input.workspaceId);
    const provider = agentConfig.provider as AgentProvider;
    const installationToken = await mintInstallationToken(input.admin, input.repository);
    if (provider === "codex") {
      await getCodexCredentialForUser(input.admin, input.userId);
    } else {
      await getClaudeCodeCredentialForUser(input.admin, input.userId);
    }

    sandbox = await createSessionSandbox({
      agentProvider: provider,
      baseBranch: input.repository.default_branch ?? "main",
      branch: `wallie/capability-check-${randomUUID().slice(0, 8)}`,
      installationToken,
      repoFullName: input.repository.full_name,
      sessionId: randomUUID(),
      timeoutMs: 30 * 60_000,
    });

    const capabilities = await probeSandboxCapabilities({
      agentProvider: provider,
      sandbox,
    });
    const success = capabilityReportSucceeded(capabilities);
    return await updateCheck({
      admin: input.admin,
      capabilities,
      checkId: input.checkId,
      errorText: success ? null : "One or more sandbox capabilities failed.",
      status: success ? "success" : "error",
    });
  } catch (error) {
    return await updateCheck({
      admin: input.admin,
      capabilities: {},
      checkId: input.checkId,
      errorText: error instanceof Error ? error.message : String(error),
      status: "error",
    });
  } finally {
    await sandbox?.stop();
  }
}
