import { execFile } from "node:child_process";

import type { SupabaseClient } from "@supabase/supabase-js";
import { App } from "@octokit/app";

import type { Database, Tables } from "@/lib/supabase/database.types";
import type { SessionPhase } from "@/features/sessions/types";
import type { AgentEvent } from "@/lib/agent-runner/types";
import { createAgentRunner, DEFAULT_AGENT_RUNNER_CONFIG } from "@/lib/agent-runner";
import { createWorkspace, destroyWorkspace } from "@/lib/workspace-manager/manager";
import { renderPhasePrompt } from "@/lib/prompt-templates";
import { resolveGitHubAppConfig } from "@/features/github/config";

type AdminClient = SupabaseClient<Database>;
type SessionRow = Tables<"sessions">;

interface EngineeringPhaseInput {
  admin: AdminClient;
  job: Tables<"agent_jobs">;
  session: SessionRow;
  botToken: string;
}

interface EngineeringPhaseResult {
  jobId: string;
  processed: boolean;
  result: "error" | "success";
  runId: string | null;
}

/**
 * Run the engineering phase: provision a workspace, launch a coding agent
 * with multi-turn support, create a PR, and store artifacts.
 */
export async function runEngineeringPhase(
  input: EngineeringPhaseInput,
): Promise<EngineeringPhaseResult> {
  const { admin, job, session } = input;

  // --- Load configuration ---
  const agentConfig = await loadAgentConfig(admin, session.workspace_id);
  const maxTurns = agentConfig.maxTurns ?? DEFAULT_AGENT_RUNNER_CONFIG.maxTurns ?? 5;
  const provider = agentConfig.provider ?? DEFAULT_AGENT_RUNNER_CONFIG.provider;

  // --- Load GitHub installation + repository ---
  const github = await loadGitHubContext(admin, session.workspace_id);
  if (!github) {
    return errorResult(
      admin,
      job,
      "No GitHub installation or repository found for workspace. " +
        "Connect a GitHub repository in workspace settings.",
    );
  }

  // --- Load previous artifacts for prompt context ---
  const productSpec = await loadPhaseArtifactText(admin, session.id, "product");
  const designDoc = await loadPhaseArtifactText(admin, session.id, "design");

  // --- Load feedback from previous rejection (if any) ---
  const attemptNumber = session.current_artifact_version + 1;
  let feedbackText: string | null = null;
  if (session.current_artifact_version > 0) {
    const lastArtifact = await loadLatestArtifact(admin, session.id, session.phase);
    feedbackText = lastArtifact?.feedback_text ?? null;
  }

  // --- Render the prompt ---
  const prompt = await renderPhasePrompt(admin, {
    workspaceId: session.workspace_id,
    phase: "engineering",
    sessionTitle: session.title,
    sessionPrompt: session.prompt_md,
    attemptNumber,
    attemptFeedback: feedbackText,
    repoName: github.repo.name,
    repoFullName: github.repo.full_name,
    repoDefaultBranch: github.repo.default_branch ?? "main",
    productSpec,
    designDoc,
  });

  // --- Provision workspace ---
  const repoUrl = buildCloneUrl(github.installationId, github.repo.full_name);
  const branch = `wallie/session-${session.id}`;
  let workspace: { branch: string; path: string } | null = null;

  try {
    workspace = await createWorkspace({
      repoUrl,
      sessionId: session.id,
      branch,
    });
  } catch (err) {
    return errorResult(
      admin,
      job,
      `Failed to provision workspace: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // --- Create agent run record ---
  const { data: run, error: runError } = await admin
    .from("agent_runs")
    .insert({
      agent_job_id: job.id,
      issue_id: job.issue_id ?? session.issue_id ?? undefined,
      model_name: agentConfig.model ?? "claude-code",
      model_provider: provider,
      run_type: "engineering",
      status: "running" as const,
      started_at: new Date().toISOString(),
      workspace_id: session.workspace_id,
    })
    .select("id")
    .single();

  if (runError || !run) {
    await cleanupWorkspace(session.id);
    return errorResult(admin, job, `Failed to create agent_run: ${runError?.message ?? "unknown"}`);
  }

  const runId = run.id;

  try {
    // --- Multi-turn agent loop ---
    const runner = createAgentRunner(provider);
    let continueSessionId: string | undefined;
    let turnCount = 0;
    let taskComplete = false;

    for (let turn = 0; turn < maxTurns; turn++) {
      turnCount = turn + 1;

      // Update activity timestamp.
      await admin
        .from("agent_runs")
        .update({ last_activity_at: new Date().toISOString() })
        .eq("id", runId);

      // Launch agent for this turn.
      const turnPrompt =
        turn === 0
          ? prompt
          : "Continue working on the task. Review what you've done so far and complete any remaining work.";

      const events = runner.start({
        sessionId: session.id,
        workspacePath: workspace.path,
        prompt: turnPrompt,
        continueSessionId,
      });

      // Stream events and persist to agent_run_messages.
      let turnHasCompletion = false;
      for await (const event of events) {
        await persistEvent(admin, runId, session.workspace_id, event);

        // Update activity on every event for stall detection.
        await admin
          .from("agent_runs")
          .update({ last_activity_at: new Date().toISOString() })
          .eq("id", runId);

        if (event.type === "completion") {
          turnHasCompletion = true;
          taskComplete = event.taskComplete;
          // Extract session ID for continuation.
          const sessionIdMatch = event.summary.match(/session:\s*(\S+)/i);
          if (sessionIdMatch) {
            continueSessionId = sessionIdMatch[1];
          }
        }

        if (event.type === "error") {
          // Log but don't abort — the agent might recover in next messages.
          console.error("[engineering] Agent error event", {
            message: event.message,
            runId,
            turn: turnCount,
          });
        }
      }

      // Check if there are actual code changes after this turn.
      const hasChanges = await gitHasChanges(workspace.path);

      if (hasChanges) {
        // Commit and push in-progress work between turns.
        await gitCommitAll(workspace.path, `wallie: engineering turn ${turnCount}`);
        await gitPush(workspace.path, branch);
      }

      // Check if the agent considers the task complete.
      if (taskComplete || turnHasCompletion) {
        break;
      }

      // Between turns: check if the Linear issue is still active (reconciliation).
      if (session.linear_issue_id) {
        const stillActive = await isLinearIssueActive(admin, session.id);
        if (!stillActive) {
          await persistEvent(admin, runId, session.workspace_id, {
            type: "text",
            text: "Linear issue is no longer active. Stopping agent.",
          });
          break;
        }
      }
    }

    // --- Ensure final changes are committed and pushed ---
    const hasFinalChanges = await gitHasChanges(workspace.path);
    if (hasFinalChanges) {
      await gitCommitAll(workspace.path, `wallie: engineering final`);
      await gitPush(workspace.path, branch);
    }

    // --- Create PR via GitHub App ---
    let prUrl: string | null = null;
    let prNumber: number | null = null;

    // Only create PR if we have commits beyond the base.
    const hasCommits = await gitHasCommitsAhead(
      workspace.path,
      github.repo.default_branch ?? "main",
    );
    if (hasCommits) {
      try {
        const pr = await createPullRequest({
          installationId: github.installationId,
          repoFullName: github.repo.full_name,
          branch,
          baseBranch: github.repo.default_branch ?? "main",
          title: `[Wallie] ${session.title}`,
          body: buildPrBody(session, turnCount),
        });
        prUrl = pr.url;
        prNumber = pr.number;
      } catch (prErr) {
        // PR creation failure is non-fatal — the code is already pushed.
        console.error("[engineering] PR creation failed", {
          error: prErr instanceof Error ? prErr.message : String(prErr),
          runId,
        });
      }
    }

    // --- Store PR in session_pull_requests ---
    if (prUrl || hasCommits) {
      await admin.from("session_pull_requests").upsert(
        {
          session_id: session.id,
          workspace_id: session.workspace_id,
          branch_name: branch,
          github_repository_id: github.repoDbId,
          pull_request_number: prNumber,
          pull_request_url: prUrl,
          pull_request_state: prNumber ? "open" : null,
          is_draft: false,
        },
        { onConflict: "session_id,branch_name" },
      );
    }

    // --- Store engineering artifact ---
    const newVersion = session.current_artifact_version + 1;
    const artifactMd = buildEngineeringArtifact({
      branch,
      prUrl,
      prNumber,
      turnCount,
      taskComplete,
    });

    await admin.from("session_artifacts").insert({
      artifact_json: artifactMd,
      feedback_text: null,
      phase: session.phase,
      session_id: session.id,
      version: newVersion,
      workspace_id: session.workspace_id,
    });

    await admin
      .from("sessions")
      .update({
        current_artifact_version: newVersion,
        phase_status: "awaiting_review",
      })
      .eq("id", session.id);

    // --- Mark run as success ---
    await admin
      .from("agent_runs")
      .update({
        finished_at: new Date().toISOString(),
        status: "success" as const,
      })
      .eq("id", runId);

    return { jobId: job.id, processed: true, result: "success", runId };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Engineering phase failed";

    await admin
      .from("agent_runs")
      .update({
        finished_at: new Date().toISOString(),
        status: "error" as const,
      })
      .eq("id", runId);

    return errorResult(admin, job, message, runId);
  } finally {
    // Cleanup workspace (non-fatal if this fails).
    await cleanupWorkspace(session.id);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function errorResult(
  admin: AdminClient,
  job: Tables<"agent_jobs">,
  message: string,
  runId: string | null = null,
): Promise<EngineeringPhaseResult> {
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

async function cleanupWorkspace(sessionId: string): Promise<void> {
  try {
    await destroyWorkspace({ sessionId });
  } catch (err) {
    console.error("[engineering] Workspace cleanup failed", {
      error: err instanceof Error ? err.message : String(err),
      sessionId,
    });
  }
}

async function loadAgentConfig(
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

interface GitHubContext {
  installationId: number;
  repo: {
    default_branch: string | null;
    full_name: string;
    name: string;
  };
  repoDbId: string;
}

async function loadGitHubContext(
  admin: AdminClient,
  workspaceId: string,
): Promise<GitHubContext | null> {
  // Load GitHub installation.
  const { data: installation } = await admin
    .from("github_installations")
    .select("id, installation_id")
    .eq("workspace_id", workspaceId)
    .maybeSingle();

  if (!installation) return null;

  // Load the first non-archived repository.
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

async function loadPhaseArtifactText(
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

async function loadLatestArtifact(
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

async function isLinearIssueActive(admin: AdminClient, sessionId: string): Promise<boolean> {
  const { data } = await admin
    .from("sessions")
    .select("phase_status")
    .eq("id", sessionId)
    .maybeSingle();

  // If the session has been canceled/escalated, treat as inactive.
  if (!data) return false;
  return data.phase_status === "agent_generating";
}

/**
 * Build a clone URL that authenticates via the GitHub App installation token.
 * The token is embedded in the URL so `git clone` works without SSH keys.
 */
function buildCloneUrl(installationId: number, repoFullName: string): string {
  // For now, use the HTTPS URL. The workspace manager's git clone will need
  // an installation token for private repos. We generate this on-the-fly.
  // The actual token injection happens via git credential helper or we
  // pre-configure it in the workspace. For public repos, plain HTTPS works.
  return `https://github.com/${repoFullName}.git`;
}

async function persistEvent(
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
// Git helpers
// ---------------------------------------------------------------------------

function gitExec(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, timeout: 60_000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`git ${args[0]} failed: ${stderr || error.message}`));
        return;
      }
      resolve(stdout);
    });
  });
}

async function gitHasChanges(cwd: string): Promise<boolean> {
  const status = await gitExec(["status", "--porcelain"], cwd);
  return status.trim().length > 0;
}

async function gitCommitAll(cwd: string, message: string): Promise<void> {
  await gitExec(["add", "-A"], cwd);
  await gitExec(["commit", "-m", message, "--allow-empty-message"], cwd);
}

async function gitPush(cwd: string, branch: string): Promise<void> {
  await gitExec(["push", "-u", "origin", branch, "--force-with-lease"], cwd);
}

async function gitHasCommitsAhead(cwd: string, baseBranch: string): Promise<boolean> {
  try {
    // Fetch the base branch to compare against.
    await gitExec(["fetch", "origin", baseBranch], cwd);
    const log = await gitExec(["log", `origin/${baseBranch}..HEAD`, "--oneline"], cwd);
    return log.trim().length > 0;
  } catch {
    // If fetch fails (e.g. base branch doesn't exist on remote), assume we have commits.
    return true;
  }
}

// ---------------------------------------------------------------------------
// GitHub PR creation
// ---------------------------------------------------------------------------

async function createPullRequest(input: {
  installationId: number;
  repoFullName: string;
  branch: string;
  baseBranch: string;
  title: string;
  body: string;
}): Promise<{ number: number; url: string }> {
  const config = resolveGitHubAppConfig();
  const app = new App(config);
  const octokit = await app.getInstallationOctokit(input.installationId);

  const [owner, repo] = input.repoFullName.split("/");
  if (!owner || !repo) {
    throw new Error(`Invalid repo full name: ${input.repoFullName}`);
  }

  const { data: pr } = await octokit.request("POST /repos/{owner}/{repo}/pulls", {
    owner,
    repo,
    title: input.title,
    body: input.body,
    head: input.branch,
    base: input.baseBranch,
  });

  return {
    number: pr.number,
    url: pr.html_url,
  };
}

function buildPrBody(session: SessionRow, turnCount: number): string {
  const lines: string[] = [];
  lines.push(`## Wallie Engineering Phase`);
  lines.push("");
  lines.push(`**Session:** ${session.title}`);
  lines.push(`**Turns:** ${turnCount}`);
  lines.push("");
  lines.push("### Description");
  lines.push("");
  lines.push(session.prompt_md);
  lines.push("");
  lines.push("---");
  lines.push("_This PR was generated by [Wallie](https://wallie.cc)._");
  return lines.join("\n");
}

function buildEngineeringArtifact(input: {
  branch: string;
  prUrl: string | null;
  prNumber: number | null;
  turnCount: number;
  taskComplete: boolean;
}): string {
  const lines: string[] = [];
  lines.push("# Engineering");
  lines.push("");
  lines.push(`**Branch:** \`${input.branch}\``);
  if (input.prUrl) {
    lines.push(`**Pull Request:** [#${input.prNumber}](${input.prUrl})`);
  }
  lines.push(`**Agent Turns:** ${input.turnCount}`);
  lines.push(`**Task Complete:** ${input.taskComplete ? "Yes" : "No (hit turn limit)"}`);
  lines.push("");
  return lines.join("\n");
}
