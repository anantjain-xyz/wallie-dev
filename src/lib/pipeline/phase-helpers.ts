import { execFile } from "node:child_process";

import type { SupabaseClient } from "@supabase/supabase-js";
import { App } from "@octokit/app";

import type { Database, Tables } from "@/lib/supabase/database.types";
import type { SessionPhase } from "@/features/sessions/types";
import type { AgentEvent } from "@/lib/agent-runner/types";
import { resolveGitHubAppConfig } from "@/features/github/config";

export type AdminClient = SupabaseClient<Database>;
export type SessionRow = Tables<"sessions">;

export interface PhaseResult {
  jobId: string;
  processed: boolean;
  result: "error" | "success";
  runId: string | null;
}

// ---------------------------------------------------------------------------
// Data access helpers
// ---------------------------------------------------------------------------

export async function loadAgentConfig(
  admin: AdminClient,
  workspaceId: string,
): Promise<{ maxTurns?: number; model?: string; provider?: string }> {
  const { data } = await admin
    .from("workspace_agent_config")
    .select("key, value_json")
    .eq("workspace_id", workspaceId)
    .in("key", ["max_turns", "agent_provider", "agent_model"]);

  const config: Record<string, unknown> = {};
  for (const row of data ?? []) {
    config[row.key] = row.value_json;
  }

  return {
    maxTurns: typeof config.max_turns === "number" ? config.max_turns : undefined,
    model: typeof config.agent_model === "string" ? config.agent_model : undefined,
    provider: typeof config.agent_provider === "string" ? config.agent_provider : undefined,
  };
}

export interface GitHubContext {
  installationId: number;
  repo: {
    default_branch: string | null;
    full_name: string;
    name: string;
  };
  repoDbId: string;
}

export async function loadGitHubContext(
  admin: AdminClient,
  workspaceId: string,
): Promise<GitHubContext | null> {
  const { data: installation } = await admin
    .from("github_installations")
    .select("id, installation_id")
    .eq("workspace_id", workspaceId)
    .maybeSingle();

  if (!installation) return null;

  const { data: repo } = await admin
    .from("github_repositories")
    .select("id, name, full_name, default_branch")
    .eq("github_installation_id", installation.id)
    .eq("is_archived", false)
    .order("full_name", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!repo) return null;

  return {
    installationId: installation.installation_id,
    repo: {
      default_branch: repo.default_branch,
      full_name: repo.full_name,
      name: repo.name,
    },
    repoDbId: repo.id,
  };
}

export async function loadPhaseArtifactText(
  admin: AdminClient,
  sessionId: string,
  phase: SessionPhase,
): Promise<string | null> {
  const { data } = await admin
    .from("session_artifacts")
    .select("artifact_json")
    .eq("session_id", sessionId)
    .eq("phase", phase)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!data) return null;

  const raw = data.artifact_json;
  if (typeof raw === "string") return raw;
  return JSON.stringify(raw);
}

export async function loadLatestArtifact(
  admin: AdminClient,
  sessionId: string,
  phase: SessionPhase,
): Promise<Tables<"session_artifacts"> | null> {
  const { data } = await admin
    .from("session_artifacts")
    .select("*")
    .eq("session_id", sessionId)
    .eq("phase", phase)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();

  return data;
}

export async function loadSessionPullRequest(
  admin: AdminClient,
  sessionId: string,
): Promise<Tables<"session_pull_requests"> | null> {
  const { data } = await admin
    .from("session_pull_requests")
    .select("*")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return data;
}

export async function isLinearIssueActive(admin: AdminClient, sessionId: string): Promise<boolean> {
  const { data } = await admin
    .from("sessions")
    .select("phase_status")
    .eq("id", sessionId)
    .maybeSingle();

  if (!data) return false;
  return data.phase_status === "agent_generating";
}

// ---------------------------------------------------------------------------
// Agent run helpers
// ---------------------------------------------------------------------------

export async function createAgentRun(
  admin: AdminClient,
  input: {
    jobId: string;
    sessionId: string;
    model: string;
    provider: string;
    runType: string;
    workspaceId: string;
  },
): Promise<string | null> {
  const { data, error } = await admin
    .from("agent_runs")
    .insert({
      agent_job_id: input.jobId,
      session_id: input.sessionId,
      model_name: input.model,
      model_provider: input.provider,
      run_type: input.runType,
      status: "running" as const,
      started_at: new Date().toISOString(),
      workspace_id: input.workspaceId,
    })
    .select("id")
    .single();

  if (error || !data) return null;
  return data.id;
}

export async function markRunSuccess(
  admin: AdminClient,
  runId: string,
  tokenUsage?: { inputTokens: number; outputTokens: number; totalCostUsd?: number },
): Promise<void> {
  await admin
    .from("agent_runs")
    .update({
      finished_at: new Date().toISOString(),
      status: "success" as const,
      ...(tokenUsage
        ? {
            input_tokens: tokenUsage.inputTokens,
            output_tokens: tokenUsage.outputTokens,
            total_cost_usd: tokenUsage.totalCostUsd ?? null,
          }
        : {}),
    })
    .eq("id", runId);
}

export async function markRunError(admin: AdminClient, runId: string): Promise<void> {
  await admin
    .from("agent_runs")
    .update({
      finished_at: new Date().toISOString(),
      status: "error" as const,
    })
    .eq("id", runId);
}

export async function updateRunActivity(admin: AdminClient, runId: string): Promise<void> {
  await admin
    .from("agent_runs")
    .update({ last_activity_at: new Date().toISOString() })
    .eq("id", runId);
}

export async function persistEvent(
  admin: AdminClient,
  runId: string,
  workspaceId: string,
  event: AgentEvent,
): Promise<void> {
  let kind: string;
  let messageMd: string;

  switch (event.type) {
    case "text":
      kind = "text";
      messageMd = event.text;
      break;
    case "tool_use":
      kind = "tool_use";
      messageMd = `**Tool:** ${event.tool}\n\n\`\`\`\n${event.input}\n\`\`\``;
      break;
    case "completion":
      kind = "completion";
      messageMd = event.summary;
      break;
    case "error":
      kind = "error";
      messageMd = `**Error:** ${event.message}`;
      break;
  }

  await admin.from("agent_run_messages").insert({
    agent_run_id: runId,
    kind,
    message_md: messageMd,
    workspace_id: workspaceId,
  });
}

// ---------------------------------------------------------------------------
// Job result helpers
// ---------------------------------------------------------------------------

export async function errorResult(
  admin: AdminClient,
  job: Tables<"agent_jobs">,
  message: string,
  runId: string | null = null,
): Promise<PhaseResult> {
  await admin
    .from("agent_jobs")
    .update({
      finished_at: new Date().toISOString(),
      last_error: message,
      status: "error",
    })
    .eq("id", job.id);

  return { jobId: job.id, processed: true, result: "error", runId };
}

export async function successResult(
  admin: AdminClient,
  job: Tables<"agent_jobs">,
  runId: string | null = null,
): Promise<PhaseResult> {
  await admin
    .from("agent_jobs")
    .update({
      finished_at: new Date().toISOString(),
      status: "success",
    })
    .eq("id", job.id);

  return { jobId: job.id, processed: true, result: "success", runId };
}

// ---------------------------------------------------------------------------
// Workspace helpers
// ---------------------------------------------------------------------------

export async function cleanupWorkspace(sessionId: string): Promise<void> {
  // Lazy-import to avoid pulling in Node fs modules at the top level.
  const { destroyWorkspace } = await import("@/lib/workspace-manager/manager");
  try {
    await destroyWorkspace({ sessionId });
  } catch (err) {
    console.error("[phase] Workspace cleanup failed", {
      error: err instanceof Error ? err.message : String(err),
      sessionId,
    });
  }
}

export function buildCloneUrl(_installationId: number, repoFullName: string): string {
  return `https://github.com/${repoFullName}.git`;
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

export function gitExec(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, timeout: 60_000 },
      (error: Error | null, stdout: string, stderr: string) => {
        if (error) {
          reject(new Error(`git ${args[0]} failed: ${stderr || error.message}`));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

export async function gitHasChanges(cwd: string): Promise<boolean> {
  const status = await gitExec(["status", "--porcelain"], cwd);
  return status.trim().length > 0;
}

export async function gitCommitAll(cwd: string, message: string): Promise<void> {
  await gitExec(["add", "-A"], cwd);
  await gitExec(["commit", "-m", message, "--allow-empty-message"], cwd);
}

export async function gitPush(cwd: string, branch: string): Promise<void> {
  await gitExec(["push", "-u", "origin", branch, "--force-with-lease"], cwd);
}

// ---------------------------------------------------------------------------
// GitHub App helpers
// ---------------------------------------------------------------------------

export function createOctokit(installationId: number) {
  const config = resolveGitHubAppConfig();
  const app = new App(config);
  return app.getInstallationOctokit(installationId);
}

export function splitRepoFullName(fullName: string): { owner: string; repo: string } {
  const [owner, repo] = fullName.split("/");
  if (!owner || !repo) {
    throw new Error(`Invalid repo full name: ${fullName}`);
  }
  return { owner, repo };
}
