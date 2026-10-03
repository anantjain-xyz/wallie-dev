import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, Tables } from "@/lib/supabase/database.types";
import type { AgentEvent, AgentRunner } from "@/lib/agent-runner/types";
import type { CreateAgentRunnerOptions } from "@/lib/agent-runner";
import { FakeSandbox } from "@/lib/sandbox/fake";
import { normalizeAgentProviderName, type AgentProvider } from "@/lib/agent-config/contracts";

// ---- hoisted mocks ------------------------------------------------------
const mocked = vi.hoisted(() => ({
  assertCurrentSandboxCapabilityCheck: vi.fn().mockResolvedValue(undefined),
  createSupabaseAdminClient: vi.fn(),
  createAgentRunner: vi.fn(),
  createSessionSandbox: vi.fn().mockResolvedValue({
    id: "sandbox-1",
    repoPath: "/vercel/sandbox",
    exec: vi.fn(),
    readFile: vi.fn(),
    stop: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn(),
  }),
  getCodexCredentialForSession: vi.fn().mockResolvedValue({
    expiresAt: null,
    secret: "codex-token",
    type: "codex_access_token",
  }),
  getClaudeCodeCredentialForSession: vi.fn().mockResolvedValue({
    secret: "sk-ant-test",
  }),
  getCursorCredentialForSession: vi.fn().mockResolvedValue({
    expiresAt: "2026-12-01T00:00:00.000Z",
    generation: "11111111-1111-4111-8111-111111111111",
    secret: "cursor-test",
    userId: "user-1",
  }),
  getOpenCodeAuthForSession: vi.fn().mockResolvedValue({
    credential: { secret: "zen-test" },
    providerCredentials: {},
  }),
  markCursorReconnectRequired: vi.fn(),
  octokitRequest: vi.fn().mockResolvedValue({ data: { token: "gh-token" } }),
  loadStageById: vi.fn(),
  loadCompletedStageArtifacts: vi.fn().mockResolvedValue({}),
  loadPipelineOperatingRules: vi.fn().mockResolvedValue(""),
  loadSessionAttachmentInputs: vi.fn().mockResolvedValue([]),
  materializeSessionAttachments: vi.fn().mockResolvedValue([]),
  formatSessionAttachmentPromptData: vi.fn(() => ""),
  loadWorkspaceAgentConfig: vi.fn(),
  loadRequiredWorkspaceSandboxConnection: vi.fn(),
  resolveSandboxImplementation: vi.fn(() => "vercel"),
  stopSandboxById: vi.fn().mockResolvedValue(undefined),
  renderStagePrompt: vi.fn(() => "rendered prompt"),
  openSessionPullRequest: vi.fn().mockResolvedValue({
    kind: "success",
    isDraft: false,
    prNumber: 42,
    prState: "open",
    prUrl: "https://github.com/acme/app/pull/42",
  }),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: mocked.createSupabaseAdminClient,
}));

vi.mock("./stages", () => ({
  loadStageById: mocked.loadStageById,
  loadCompletedStageArtifacts: mocked.loadCompletedStageArtifacts,
  loadPipelineOperatingRules: mocked.loadPipelineOperatingRules,
}));

vi.mock("./pull-request", () => ({
  openSessionPullRequest: mocked.openSessionPullRequest,
}));

vi.mock("@/lib/prompt-templates", () => ({
  renderStagePrompt: mocked.renderStagePrompt,
}));

vi.mock("@/lib/pipeline/session-attachments", () => ({
  formatSessionAttachmentPromptData: mocked.formatSessionAttachmentPromptData,
  loadSessionAttachmentInputs: mocked.loadSessionAttachmentInputs,
  materializeSessionAttachments: mocked.materializeSessionAttachments,
  SESSION_ATTACHMENT_PROMPT_INSTRUCTIONS: "attachment instructions",
}));

vi.mock("@/lib/agent-runner", () => ({
  createAgentRunner: mocked.createAgentRunner,
  DEFAULT_AGENT_RUNNER_CONFIG: {
    effort: "xhigh",
    provider: "codex",
    model: "gpt-5.5",
    maxTurns: 5,
  },
  loadWorkspaceAgentConfig: mocked.loadWorkspaceAgentConfig,
}));

vi.mock("@/lib/sandbox", () => ({
  createSessionSandbox: mocked.createSessionSandbox,
  resolveSandboxImplementation: mocked.resolveSandboxImplementation,
  stopSandboxById: mocked.stopSandboxById,
}));

vi.mock("@/lib/sandbox-connections/server", () => ({
  loadRequiredWorkspaceSandboxConnection: mocked.loadRequiredWorkspaceSandboxConnection,
}));

vi.mock("@/lib/sandbox-capabilities/readiness", () => ({
  assertCurrentSandboxCapabilityCheck: mocked.assertCurrentSandboxCapabilityCheck,
}));

vi.mock("@/lib/codex/tokens", () => ({
  CodexNotConnectedError: class CodexNotConnectedError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "CodexNotConnectedError";
    }
  },
  createCodexChatGptAuthStore: vi.fn(() => ({})),
  getCodexCredentialForSession: mocked.getCodexCredentialForSession,
}));

vi.mock("@/lib/claude-code/tokens", () => ({
  ClaudeCodeNotConnectedError: class ClaudeCodeNotConnectedError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "ClaudeCodeNotConnectedError";
    }
  },
  getClaudeCodeCredentialForSession: mocked.getClaudeCodeCredentialForSession,
}));

vi.mock("@/lib/cursor/tokens", () => ({
  CursorNotConnectedError: class CursorNotConnectedError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "CursorNotConnectedError";
    }
  },
  getCursorCredentialForSession: mocked.getCursorCredentialForSession,
  markCursorReconnectRequired: mocked.markCursorReconnectRequired,
}));

vi.mock("@/lib/opencode/tokens", () => ({
  OpenCodeNotConnectedError: class OpenCodeNotConnectedError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "OpenCodeNotConnectedError";
    }
  },
  getOpenCodeAuthForSession: mocked.getOpenCodeAuthForSession,
}));

vi.mock("@/features/github/config", () => ({
  resolveGitHubAppConfig: vi.fn(() => ({})),
}));

vi.mock("@octokit/app", () => ({
  App: vi.fn().mockImplementation(function MockApp() {
    return {
      octokit: { request: mocked.octokitRequest },
    };
  }),
}));

import { handleApproval, handleRejection, processPipelineJob } from "./processor";

// ---- fixtures -----------------------------------------------------------

function baseJob(overrides: Partial<Tables<"agent_jobs">> = {}): Tables<"agent_jobs"> {
  return {
    id: "job-1",
    workspace_id: "ws-1",
    session_id: "sess-1",
    status: "running",
    created_at: new Date().toISOString(),
    dedupe_key: "pipeline:TEAM-1:active",
    finished_at: null,
    last_error: null,
    requested_by_member_id: null,
    started_at: null,
    stage_id: null,
    stage_name: null,
    stage_slug: null,
    trigger_type: "manual_run",
    updated_at: new Date().toISOString(),
    attempt_count: 1,
    scheduled_at: null,
    ...overrides,
  };
}

function baseSession(overrides: Partial<Tables<"sessions">> = {}): Tables<"sessions"> {
  return {
    id: "sess-1",
    workspace_id: "ws-1",
    number: 1,
    title: "Add SSO",
    prompt_md: "Add SSO via Google Workspace",
    creator_member_id: null,
    github_repository_id: null,
    linear_issue_id: "TEAM-1",
    linear_issue_url: "https://linear.app/team/issue/TEAM-1",
    pipeline_id: "pipe-1",
    current_stage_id: "stage-product",
    phase_status: "in_progress",
    rejection_count: 0,
    search_document: null,
    search_text: null,
    current_artifact_version: 0,
    archived_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

const productStage = {
  approverMemberIds: [],
  description: "Write the spec",
  id: "stage-product",
  name: "Product",
  pipelineId: "pipe-1",
  position: 1,
  promptTemplateMd: "{{session.title}}",
  slug: "product",
};

// ---- supabase mock builder ---------------------------------------------

interface MockOptions {
  session: Tables<"sessions"> | null;
  agentConfig?: Array<{ key: string; value_json: unknown }>;
  claimSucceeds?: boolean;
  currentAttempt?: number;
  replacementJobId?: string;
  failRpcError?: { message: string };
  jobStatus?: string;
  artifactInsertError?: { message: string } | null;
  messageInsertError?: { message: string } | null;
  messageInsertErrorOnMessage?: string;
  pointerUpdateError?: { message: string } | null;
  pointerCasMiss?: boolean;
  feedbackInsertError?: { message: string } | null;
  latestFeedback?: { feedback_text: string } | null;
  runSandboxUpdateError?: { message: string } | null;
  runSandboxUpdateMissed?: boolean;
  runRows?: Array<Record<string, unknown>>;
  githubInstallation?: { id: string; installation_id: number } | null;
  githubRepositories?: Array<{
    default_branch: string | null;
    default_programming_language?: string | null;
    full_name: string;
    github_installation_id?: string;
    html_url?: string;
    id: string;
    is_archived?: boolean;
    private?: boolean;
    workspace_id?: string;
  }>;
  onboardingRepositoryId?: string | null;
  primaryRepositoryProfile?: { github_repository_id: string } | null;
  sessionPullRequestRepositoryId?: string | null;
}

type AdminClient = SupabaseClient<Database>;
type TestAdminClient = Pick<AdminClient, "from" | "rpc">;

function createTestAdminClient(input: {
  from: (name: string) => unknown;
  rpc?: (fn: string, args?: unknown) => unknown;
}): TestAdminClient {
  return {
    from: input.from as AdminClient["from"],
    rpc: (input.rpc ??
      vi.fn(() => {
        throw new Error("Unexpected admin.rpc call in processor test admin mock");
      })) as AdminClient["rpc"],
  };
}

function createProcessorTestAdminClient(
  input: Parameters<typeof createTestAdminClient>[0],
): AdminClient {
  return createTestAdminClient(input) as AdminClient;
}

function buildAdminMock(opts: MockOptions) {
  const insertedArtifacts: Array<Record<string, unknown>> = [];
  const legacyMutationCalls: string[] = [];
  const insertedRuns: Array<Record<string, unknown>> = [];
  const insertedMessages: Array<Record<string, unknown>> = [];
  const updatedJobs: Array<Record<string, unknown>> = [];
  const updatedRuns: Array<Record<string, unknown>> = [];
  const updatedSessions: Array<Record<string, unknown>> = [];

  const runRows = opts.runRows ?? [
    {
      id: "run-1",
      agent_job_id: "job-1",
      workspace_id: "ws-1",
      status: "queued",
      attempt_count: null,
    },
  ];
  let currentAttempt = opts.currentAttempt;
  const runUpdateFilters: Array<Record<string, unknown>> = [];

  const lookup: Record<string, unknown> = {};
  for (const row of opts.agentConfig ?? []) {
    lookup[row.key] = row.value_json;
  }
  const rawProvider = typeof lookup.agent_provider === "string" ? lookup.agent_provider : undefined;
  const rawModel = typeof lookup.agent_model === "string" ? lookup.agent_model : undefined;
  const rawEffort = typeof lookup.agent_effort === "string" ? lookup.agent_effort : undefined;
  const resolvedProvider = rawProvider ? normalizeAgentProviderName(rawProvider) : "codex";
  const resolvedConfig = {
    effort: rawEffort ?? "xhigh",
    maxTurns: typeof lookup.max_turns === "number" ? lookup.max_turns : undefined,
    model: rawModel ?? "gpt-5.5",
    provider: resolvedProvider ?? "codex",
  };
  mocked.loadWorkspaceAgentConfig.mockResolvedValue(resolvedConfig);

  const sessionsTable = {
    select: () => {
      const builder = {
        eq: () => builder,
        maybeSingle: async () => ({ data: opts.session, error: null }),
      };
      return builder;
    },
    update: () => {
      legacyMutationCalls.push("sessions.update");
      throw new Error("Processor must mutate session state through ownership RPCs");
    },
  };

  const insertedFeedback: Array<Record<string, unknown>> = [];
  const feedbackTable = {
    insert: async (row: Record<string, unknown>) => {
      insertedFeedback.push(row);
      return { error: opts.feedbackInsertError ?? null };
    },
    select: () => ({
      eq: () => ({
        eq: () => ({
          order: () => ({
            limit: () => ({
              maybeSingle: async () => ({ data: opts.latestFeedback ?? null, error: null }),
            }),
          }),
        }),
      }),
    }),
  } as const;

  const agentConfigTable = {
    select: () => ({
      eq: () => ({
        in: async () => ({ data: opts.agentConfig ?? [], error: null }),
        eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
      }),
    }),
  } as const;

  const agentRunsTable = {
    select: () => {
      const chain = {
        eq: () => chain,
        in: () => chain,
        limit: () => chain,
        maybeSingle: async () => ({ data: { id: "run-1" }, error: null }),
        order: () => chain,
      };
      return chain;
    },
    update: (patch: Record<string, unknown>) => {
      const filters: Record<string, unknown> = {};
      const matches: Array<(row: Record<string, unknown>) => boolean> = [];
      const chain = {
        eq: (column: string, value: unknown) => {
          filters[column] = value;
          matches.push((row) => row[column] === value);
          return chain;
        },
        in: (column: string, values: unknown[]) => {
          filters[column] = values;
          matches.push((row) => values.includes(row[column]));
          return chain;
        },
        select: () => chain,
        then: (
          resolve: (value: {
            data: Record<string, unknown>[];
            error: { message: string } | null;
          }) => void,
        ) => {
          runUpdateFilters.push(filters);
          const missed = "sandbox_id" in patch && opts.runSandboxUpdateMissed;
          const rows = missed ? [] : runRows.filter((row) => matches.every((match) => match(row)));
          if (rows.length) {
            updatedRuns.push(patch);
            for (const row of rows) Object.assign(row, patch);
          }
          resolve({
            data: rows,
            error: "sandbox_id" in patch ? (opts.runSandboxUpdateError ?? null) : null,
          });
        },
      };
      return chain;
    },
  };

  const agentRunMessagesTable = {
    insert: async (row: Record<string, unknown>) => {
      if (
        opts.messageInsertError &&
        (!opts.messageInsertErrorOnMessage || row.message_md === opts.messageInsertErrorOnMessage)
      ) {
        return { error: opts.messageInsertError };
      }

      insertedMessages.push(row);
      return { error: null };
    },
  } as const;

  const workspaceMembersTable = {
    select: () => ({
      eq: () => ({
        eq: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
        }),
      }),
    }),
  } as const;

  const githubInstallation =
    opts.githubInstallation === undefined
      ? { id: "ghi-1", installation_id: 123 }
      : opts.githubInstallation;
  const githubRepositories = opts.githubRepositories ?? [
    {
      default_branch: "main",
      full_name: "acme/app",
      github_installation_id: "ghi-1",
      id: "repo-1",
      is_archived: false,
    },
  ];
  const githubInstallationsTable = {
    select: () => {
      const chain = {
        eq: () => chain,
        maybeSingle: async () => ({ data: githubInstallation, error: null }),
      };
      return chain;
    },
  } as const;

  const githubRepositoriesTable = {
    select: () => {
      const filters: Record<string, unknown> = {};
      const builder = {
        eq: (column: string, value: unknown) => {
          filters[column] = value;
          return builder;
        },
        limit: () => builder,
        maybeSingle: async () => {
          const row = githubRepositories
            .filter((repository) =>
              filters.github_installation_id
                ? repository.github_installation_id === filters.github_installation_id
                : true,
            )
            .filter((repository) =>
              typeof filters.is_archived === "boolean"
                ? Boolean(repository.is_archived) === filters.is_archived
                : true,
            )
            .filter((repository) => (filters.id ? repository.id === filters.id : true))
            .sort((a, b) => a.full_name.localeCompare(b.full_name))[0];

          return {
            data: row
              ? {
                  default_branch: row.default_branch,
                  default_programming_language: row.default_programming_language ?? null,
                  full_name: row.full_name,
                  github_installation_id: row.github_installation_id ?? "ghi-1",
                  html_url: row.html_url ?? `https://github.com/${row.full_name}`,
                  id: row.id,
                  is_archived: Boolean(row.is_archived),
                  private: Boolean(row.private),
                }
              : null,
            error: null,
          };
        },
        order: () => builder,
      };
      return builder;
    },
  };

  const workspaceRepositoryProfilesTable = {
    select: () => ({
      eq: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data:
              opts.primaryRepositoryProfile === undefined ? null : opts.primaryRepositoryProfile,
            error: null,
          }),
        }),
      }),
    }),
  } as const;

  const sessionPullRequestsTable = {
    select: () => ({
      eq: () => ({
        eq: () => ({
          order: () => ({
            limit: () => ({
              maybeSingle: async () => ({
                data:
                  opts.sessionPullRequestRepositoryId === undefined ||
                  opts.sessionPullRequestRepositoryId === null
                    ? null
                    : { github_repository_id: opts.sessionPullRequestRepositoryId },
                error: null,
              }),
            }),
          }),
        }),
      }),
    }),
  } as const;

  const workspaceOnboardingTable = {
    select: () => ({
      eq: () => ({
        maybeSingle: async () => ({
          data:
            opts.onboardingRepositoryId === null
              ? null
              : { selected_github_repository_id: opts.onboardingRepositoryId ?? "repo-1" },
          error: null,
        }),
      }),
    }),
  } as const;

  const tables: Record<string, unknown> = {
    sessions: sessionsTable,
    session_artifact_feedback: feedbackTable,
    workspace_agent_config: agentConfigTable,
    agent_runs: agentRunsTable,
    agent_run_messages: agentRunMessagesTable,
    workspace_members: workspaceMembersTable,
    github_installations: githubInstallationsTable,
    github_repositories: githubRepositoriesTable,
    session_pull_requests: sessionPullRequestsTable,
    workspace_onboarding: workspaceOnboardingTable,
    workspace_repository_profiles: workspaceRepositoryProfilesTable,
  };

  const rpc = vi.fn(async (fn: string, args?: unknown) => {
    const payload = (args ?? {}) as Record<string, unknown>;
    const attempt = payload.p_attempt_count as number;
    const stale =
      opts.jobStatus === "canceled" ||
      (opts.replacementJobId && opts.replacementJobId !== payload.p_job_id) ||
      (opts.currentAttempt ?? currentAttempt ?? attempt) > attempt;
    if (fn === "start_session_job_attempt") {
      if (
        opts.claimSucceeds === false ||
        stale ||
        runRows.some((row) => row.attempt_count === attempt)
      ) {
        return { data: null, error: null };
      }
      currentAttempt = attempt;
      for (const row of runRows) {
        if (
          typeof row.attempt_count === "number" &&
          row.attempt_count < attempt &&
          ["queued", "started", "running"].includes(String(row.status))
        )
          row.status = "error";
      }
      let run = runRows.find((row) => row.status === "queued" && row.attempt_count == null);
      if (!run) {
        run = {
          id: `run-${runRows.length + 1}`,
          agent_job_id: payload.p_job_id,
          workspace_id: "ws-1",
        };
        runRows.push(run);
        insertedRuns.push(run);
      }
      const patch = {
        status: "running",
        attempt_count: attempt,
        branch_name: payload.p_branch_name,
        model_name: payload.p_model_name,
        model_provider: payload.p_model_provider,
        run_type: payload.p_run_type,
        stage_id: payload.p_expected_stage_id,
        stage_name: "Product",
        stage_slug: "product",
      };
      Object.assign(run, patch);
      updatedRuns.push(patch);
      updatedSessions.push({ phase_status: "in_progress" });
      return { data: run.id, error: null };
    }
    const run = runRows.find((row) => row.id === payload.p_run_id && row.attempt_count === attempt);
    if (fn === "publish_session_job_attempt") {
      if (opts.pointerUpdateError || opts.artifactInsertError)
        return { data: null, error: opts.pointerUpdateError ?? opts.artifactInsertError };
      if (opts.pointerCasMiss || stale || run?.status !== "running")
        return { data: false, error: null };
      insertedArtifacts.push({
        artifact_json: payload.p_artifact_json,
        stage_slug: "product",
        version: Number(payload.p_expected_artifact_version) + 1,
      });
      updatedSessions.push({
        current_artifact_version: Number(payload.p_expected_artifact_version) + 1,
        phase_status: "awaiting_review",
      });
      run.status = "success";
      updatedRuns.push({ status: "success" });
      return { data: true, error: null };
    }
    if (fn === "complete_session_job_attempt") {
      if (stale || run?.status !== "success") return { data: false, error: null };
      updatedJobs.push({ status: "success" });
      return { data: true, error: null };
    }
    if (fn === "fail_session_job_attempt") {
      if (opts.failRpcError) return { data: null, error: opts.failRpcError };
      if (stale || (!payload.p_run_id && runRows.some((row) => row.attempt_count === attempt)))
        return { data: "stale", error: null };
      if (run?.status === "success") {
        updatedJobs.push({ status: "success" });
        return { data: "success", error: null };
      }
      if (run) {
        run.status = "error";
        updatedRuns.push({ status: "error" });
      }
      const retrying = payload.p_retry && attempt < Number(payload.p_max_retries);
      updatedJobs.push({ status: retrying ? "queued" : "error", last_error: payload.p_error });
      if (opts.session?.phase_status !== "approved")
        updatedSessions.push({ phase_status: "rejected" });
      return { data: retrying ? "queued" : "error", error: null };
    }
    throw new Error(`Unexpected RPC ${fn}`);
  });

  return {
    admin: createProcessorTestAdminClient({
      from: (name: string) => {
        if (name === "session_artifacts" || name === "agent_jobs") {
          legacyMutationCalls.push(name);
          throw new Error(`Processor must mutate ${name} through ownership RPCs`);
        }
        return tables[name] ?? {};
      },
      rpc,
    }),
    insertedArtifacts,
    legacyMutationCalls,
    insertedMessages,
    insertedRuns,
    insertedFeedback,
    updatedJobs,
    updatedRuns,
    updatedSessions,
    runRows,
    runUpdateFilters,
    rpc,
  };
}

// ---- agent-runner mock --------------------------------------------------

function makeRunner(
  events: AgentEvent[],
  opts: { provider?: AgentProvider; requiresSandbox?: boolean } = {},
): AgentRunner {
  return {
    provider: opts.provider ?? "claude-code",
    requiresSandbox: opts.requiresSandbox ?? true,
    start: vi.fn(async function* () {
      for (const event of events) yield event;
    }),
  };
}

// ---- tests --------------------------------------------------------------

describe("processPipelineJob (generic stage runner)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked.resolveSandboxImplementation.mockReturnValue("vercel");
    mocked.createSessionSandbox.mockImplementation(async (input) => {
      await input.onSandboxCreated?.({ provider: "vercel", sandboxId: "sandbox-1" });
      return {
        id: "sandbox-1",
        repoPath: "/vercel/sandbox",
        exec: vi.fn(),
        readFile: vi.fn(),
        stop: vi.fn().mockResolvedValue(undefined),
        writeFile: vi.fn(),
      };
    });
    mocked.loadStageById.mockResolvedValue(productStage);
    mocked.loadRequiredWorkspaceSandboxConnection.mockResolvedValue({
      connection: {
        credentials: { projectId: "prj_123", teamId: "team_123", token: "vca_secret" },
        provider: "vercel",
        revision: "revision-1",
      },
      provider: "vercel",
    });
    mocked.createAgentRunner.mockReturnValue(
      makeRunner([
        { type: "text", text: "Drafted spec body" },
        { type: "completion", taskComplete: true, summary: "Done" },
      ]),
    );
  });

  it("renders the stage prompt, runs the agent, writes the artifact, and flips status", async () => {
    const session = baseSession();
    const job = baseJob();
    mocked.loadCompletedStageArtifacts.mockResolvedValueOnce({ plan: "Approved plan" });
    mocked.loadPipelineOperatingRules.mockResolvedValueOnce(
      "Keep changes scoped to the approved plan.",
    );
    const { admin, insertedArtifacts, insertedMessages, updatedSessions } = buildAdminMock({
      session,
      agentConfig: [],
      latestFeedback: { feedback_text: "Preserve the public API." },
    });

    const result = await processPipelineJob({ admin, job });

    expect(mocked.renderStagePrompt).toHaveBeenCalledTimes(1);
    expect(mocked.renderStagePrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        promptTemplateMd: expect.objectContaining({
          source: "stage.promptTemplate",
          trust: "trusted",
          value: productStage.promptTemplateMd,
        }),
        slug: expect.objectContaining({
          source: "stage.slug",
          trust: "trusted",
          value: productStage.slug,
        }),
      }),
      expect.objectContaining({
        attemptFeedback: expect.objectContaining({
          source: "attempt.feedback",
          trust: "untrusted",
          value: "Preserve the public API.",
        }),
        operatingRulesMd: expect.objectContaining({
          source: "pipeline.operatingRules",
          trust: "trusted",
          value: "Keep changes scoped to the approved plan.",
        }),
        previousStages: {
          plan: expect.objectContaining({
            source: "artifact.previousStages.plan",
            trust: "untrusted",
            value: "Approved plan",
          }),
        },
        sessionPrompt: expect.objectContaining({
          source: "session.prompt",
          trust: "untrusted",
          value: session.prompt_md,
        }),
        sessionTitle: expect.objectContaining({
          source: "session.title",
          trust: "untrusted",
          value: session.title,
        }),
      }),
    );
    expect(mocked.createSessionSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        connection: {
          credentials: { projectId: "prj_123", teamId: "team_123", token: "vca_secret" },
          provider: "vercel",
          revision: "revision-1",
        },
      }),
    );
    const runner = mocked.createAgentRunner.mock.results[0]?.value as AgentRunner;
    expect(vi.mocked(runner.start)).toHaveBeenCalledWith(
      expect.objectContaining({ secrets: ["gh-token"] }),
    );
    expect(insertedArtifacts).toHaveLength(1);
    const artifact = insertedArtifacts[0]!;
    expect(artifact.stage_slug).toBe("product");
    expect(artifact.version).toBe(1);
    expect(artifact.artifact_json).toContain("Drafted spec body");
    expect(artifact.artifact_json).not.toContain("Done");
    expect(insertedMessages.filter((message) => message.kind !== "progress")).toEqual([
      expect.objectContaining({
        kind: "text",
        message_md: "Drafted spec body",
      }),
      expect.objectContaining({
        kind: "completion",
        message_md: "Done",
      }),
      expect.objectContaining({
        kind: "completion",
        message_md: "Product run completed",
      }),
    ]);
    expect(updatedSessions).toEqual([
      { phase_status: "in_progress" },
      { current_artifact_version: 1, phase_status: "awaiting_review" },
    ]);
    expect(result.result).toBe("success");
  });

  it("publishes only through the captured owner RPC before opening its attempt PR", async () => {
    const { admin, rpc, legacyMutationCalls } = buildAdminMock({ session: baseSession() });
    const result = await processPipelineJob({ admin, job: baseJob({ attempt_count: 4 }) });
    expect(result.result).toBe("success");
    expect(rpc).toHaveBeenCalledWith("publish_session_job_attempt", {
      p_job_id: "job-1",
      p_attempt_count: 4,
      p_run_id: "run-1",
      p_expected_artifact_version: 0,
      p_artifact_json: "Drafted spec body",
    });
    expect(legacyMutationCalls).toEqual([]);
    expect(mocked.openSessionPullRequest).toHaveBeenCalledOnce();
  });

  it("leaves artifacts untouched and stops its sandbox when publication loses ownership", async () => {
    const { admin, insertedArtifacts, legacyMutationCalls, rpc } = buildAdminMock({
      session: baseSession(),
      pointerCasMiss: true,
    });
    const result = await processPipelineJob({ admin, job: baseJob() });
    expect(result.result).toBe("idle");
    expect(insertedArtifacts).toEqual([]);
    expect(legacyMutationCalls).toEqual([]);
    expect(mocked.openSessionPullRequest).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalledWith("complete_session_job_attempt", expect.anything());
    const sandbox = await mocked.createSessionSandbox.mock.results[0]!.value;
    expect(sandbox.stop).toHaveBeenCalledOnce();
  });

  it.each(["newer attempt", "replacement job"])(
    "cannot publish after a %s takes ownership",
    async (replacement) => {
      const opts: MockOptions = { session: baseSession() };
      const { admin, insertedArtifacts, legacyMutationCalls, updatedJobs } = buildAdminMock(opts);
      mocked.createAgentRunner.mockReturnValue({
        ...makeRunner([]),
        start: vi.fn(async function* () {
          yield { type: "text", text: "Old output" } as AgentEvent;
          if (replacement === "newer attempt") opts.currentAttempt = 2;
          else opts.replacementJobId = "job-replacement";
        }),
      });
      const result = await processPipelineJob({ admin, job: baseJob() });
      expect(result.result).toBe("idle");
      expect(insertedArtifacts).toEqual([]);
      expect(legacyMutationCalls).toEqual([]);
      expect(updatedJobs).toEqual([]);
      expect(mocked.openSessionPullRequest).not.toHaveBeenCalled();
    },
  );

  it("recognizes sanitized ownership loss and stops a sandbox that lands after cancellation", async () => {
    const session = baseSession();
    const { admin, rpc, insertedMessages } = buildAdminMock({
      session,
      agentConfig: [],
      runSandboxUpdateMissed: true,
    });

    mocked.createSessionSandbox.mockImplementationOnce(async (input) => {
      try {
        await input.onSandboxCreated?.({ provider: "vercel", sandboxId: "sandbox-1" });
        throw new Error("Expected ownership callback to reject");
      } catch (error) {
        const sanitized = new Error(error instanceof Error ? error.message : String(error));
        sanitized.name = error instanceof Error ? error.name : "SandboxError";
        throw sanitized;
      }
    });
    expect((await processPipelineJob({ admin, job: baseJob() })).result).toBe("idle");
    expect(rpc.mock.calls.map(([name]) => name)).toEqual(["start_session_job_attempt"]);
    expect(insertedMessages.some((message) => message.kind === "error")).toBe(false);

    // updateRunSandbox matched zero rows (run already canceled), so the
    // freshly-created sandbox must be stopped instead of left running detached.
    expect(mocked.stopSandboxById).toHaveBeenCalledWith("sandbox-1", {
      connection: {
        credentials: { projectId: "prj_123", teamId: "team_123", token: "vca_secret" },
        provider: "vercel",
        revision: "revision-1",
      },
    });
  });

  it("bails before creating a sandbox when the job was canceled after the claim", async () => {
    const session = baseSession();
    // A workspace delete (or session cancel) flipped this job to `canceled`
    // between the worker's claim and the run start. The processor must re-check
    // the job and stop before spinning up a sandbox that the cascade would
    // orphan — its run row and Vercel credentials are about to be deleted.
    const { admin, updatedRuns } = buildAdminMock({
      session,
      agentConfig: [],
      jobStatus: "canceled",
    });

    const result = await processPipelineJob({ admin, job: baseJob() });

    expect(mocked.createSessionSandbox).not.toHaveBeenCalled();
    // The guarded start creates no run after cancellation.
    expect(updatedRuns).toEqual([]);
    expect(result.result).toBe("idle");
    expect(result.runId).toBeNull();
  });

  it("publishes explicit final output while retaining commentary and startup in history", async () => {
    mocked.createAgentRunner.mockReturnValue(
      makeRunner([
        { type: "text", text: "Inspecting the repository…" },
        { type: "text", text: "The final deliverable" },
        {
          type: "completion",
          taskComplete: true,
          summary: "Done",
          finalOutput: "The final deliverable",
        },
        { type: "completion", taskComplete: true, summary: "Cursor session completed" },
      ]),
    );
    const { admin, insertedArtifacts, insertedMessages } = buildAdminMock({
      session: baseSession(),
      agentConfig: [],
    });
    await processPipelineJob({ admin, job: baseJob() });
    expect(insertedArtifacts[0]?.artifact_json).toBe("The final deliverable");
    expect(insertedMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "text", message_md: "Inspecting the repository…" }),
        expect.objectContaining({
          kind: "progress",
          message_md: "Preparing sandbox and repository…",
        }),
        expect.objectContaining({ kind: "progress", message_md: "Starting agent…" }),
      ]),
    );
  });

  it.each(["Preparing sandbox and repository…", "Starting agent…"])(
    "continues execution when the startup hint cannot be recorded: %s",
    async (message) => {
      mocked.createAgentRunner.mockReturnValue(makeRunner([{ type: "text", text: "Deliverable" }]));
      const { admin, insertedArtifacts } = buildAdminMock({
        session: baseSession(),
        agentConfig: [],
        messageInsertError: { message: "Progress log unavailable" },
        messageInsertErrorOnMessage: message,
      });
      const result = await processPipelineJob({ admin, job: baseJob() });
      expect(result.result).toBe("success");
      expect(insertedArtifacts[0]?.artifact_json).toBe("Deliverable");
    },
  );

  it("fails the stage when the runner only emits completion bookkeeping", async () => {
    mocked.createAgentRunner.mockReturnValue(
      makeRunner([{ type: "completion", taskComplete: true, summary: "Codex session completed" }]),
    );
    const session = baseSession();
    const {
      admin,
      insertedArtifacts,
      insertedMessages,
      updatedJobs,
      updatedRuns,
      updatedSessions,
    } = buildAdminMock({
      session,
      agentConfig: [],
    });

    const result = await processPipelineJob({ admin, job: baseJob() });

    expect(result.result).toBe("error");
    expect(insertedArtifacts).toHaveLength(0);
    expect(insertedMessages.filter((message) => message.kind !== "progress")).toEqual([
      expect.objectContaining({
        kind: "error",
        message_md:
          "**Error:** Product did not produce reviewable output. Wallie only received runner bookkeeping, so no artifact was created.",
      }),
    ]);
    expect(updatedRuns.at(-1)).toMatchObject({ status: "error" });
    expect(updatedJobs.at(-1)).toMatchObject({
      last_error:
        "Product did not produce reviewable output. Wallie only received runner bookkeeping, so no artifact was created.",
      status: "error",
    });
    expect(updatedSessions).toEqual([
      { phase_status: "in_progress" },
      { phase_status: "rejected" },
    ]);
  });

  it("reuses the queued run row attached to the claimed job", async () => {
    const session = baseSession();
    const job = baseJob();
    const { admin, insertedRuns, updatedRuns } = buildAdminMock({
      session,
      agentConfig: [],
    });

    await processPipelineJob({ admin, job });

    expect(insertedRuns).toHaveLength(0);
    expect(updatedRuns[0]).toMatchObject({
      branch_name: "wallie/product-sess-1-job-job-1-attempt-1",
      model_name: "gpt-5.5",
      model_provider: "codex",
      stage_id: "stage-product",
      stage_name: "Product",
      stage_slug: "product",
      run_type: "code",
      status: "running",
    });
    expect(updatedRuns.at(-1)).toMatchObject({ status: "success" });
  });

  it("keeps overlapping job attempts on distinct branches and distinct run rows", async () => {
    const runRows: Array<Record<string, unknown>> = [
      { id: "run-1", agent_job_id: "job-1", workspace_id: "ws-1", status: "queued" },
    ];
    const { admin } = buildAdminMock({ session: baseSession(), runRows });
    let firstSetupStarted!: () => void;
    const firstSetup = new Promise<void>((resolve) => {
      firstSetupStarted = resolve;
    });
    let releaseFirstSetup!: () => void;
    const blockedSetup = new Promise<void>((resolve) => {
      releaseFirstSetup = resolve;
    });
    mocked.createSessionSandbox.mockImplementationOnce(async (input) => {
      firstSetupStarted();
      await blockedSetup;
      await input.onSandboxCreated?.({ provider: "vercel", sandboxId: "sandbox-old" });
      return new FakeSandbox("sandbox-old");
    });
    mocked.createSessionSandbox.mockImplementationOnce(async (input) => {
      await input.onSandboxCreated?.({ provider: "vercel", sandboxId: "sandbox-new" });
      return new FakeSandbox("sandbox-new");
    });

    const first = processPipelineJob({ admin, job: baseJob({ attempt_count: 1 }) });
    await firstSetup;
    const second = await processPipelineJob({ admin, job: baseJob({ attempt_count: 2 }) });
    expect(second.runId).toBe("run-2");
    expect(runRows[0]).toMatchObject({
      branch_name: "wallie/product-sess-1-job-job-1-attempt-1",
      status: "error",
    });
    releaseFirstSetup();
    expect(await first).toMatchObject({ result: "idle", runId: "run-1" });

    expect(mocked.stopSandboxById).toHaveBeenCalledWith("sandbox-old", expect.anything());
    expect(runRows[0]).not.toHaveProperty("sandbox_id");
    expect(runRows).toMatchObject([
      {
        id: "run-1",
        branch_name: "wallie/product-sess-1-job-job-1-attempt-1",
      },
      {
        id: "run-2",
        branch_name: "wallie/product-sess-1-job-job-1-attempt-2",
        sandbox_id: "sandbox-new",
      },
    ]);
    expect(
      mocked.createSessionSandbox.mock.calls.map(([input]) => [input.ownerId, input.branch]),
    ).toEqual([
      ["run-1", runRows[0].branch_name],
      ["run-2", runRows[1].branch_name],
    ]);
    expect(mocked.openSessionPullRequest.mock.calls.map(([input]) => input.branch)).toEqual([
      runRows[1].branch_name,
    ]);
  });

  it("keeps the claim identity captured before asynchronous preparation", async () => {
    const { admin, rpc, runUpdateFilters } = buildAdminMock({ session: baseSession() });
    const job = baseJob({ attempt_count: 2 });
    mocked.loadWorkspaceAgentConfig.mockImplementationOnce(async () => {
      job.id = "replacement-job";
      job.attempt_count = 3;
      return { effort: "xhigh", provider: "codex", model: "gpt-5.5" };
    });

    expect(await processPipelineJob({ admin, job })).toMatchObject({
      jobId: "job-1",
      result: "success",
      runId: "run-1",
    });
    for (const [name, args] of rpc.mock.calls) {
      expect(name).toMatch(/^(start|publish|complete)_session_job_attempt$/);
      expect(args).toMatchObject({ p_job_id: "job-1", p_attempt_count: 2 });
    }
    expect(runUpdateFilters.every((filters) => filters.attempt_count === 2)).toBe(true);
    expect(mocked.createSessionSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        branch: "wallie/product-sess-1-job-job-1-attempt-2",
      }),
    );
  });

  it("does not retire a same-attempt start winner when duplicate bootstrap is refused", async () => {
    const { admin, rpc, runRows, updatedJobs } = buildAdminMock({ session: baseSession() });
    let setupEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      setupEntered = resolve;
    });
    let releaseSetup!: () => void;
    const blocked = new Promise<void>((resolve) => {
      releaseSetup = resolve;
    });
    mocked.createSessionSandbox.mockImplementationOnce(async (input) => {
      setupEntered();
      await blocked;
      await input.onSandboxCreated?.({ provider: "vercel", sandboxId: "sandbox-1" });
      return new FakeSandbox("sandbox-1");
    });

    const first = processPipelineJob({ admin, job: baseJob() });
    await entered;
    expect(await processPipelineJob({ admin, job: baseJob() })).toMatchObject({
      result: "idle",
      runId: null,
    });
    expect(runRows[0].status).toBe("running");
    expect(updatedJobs).toEqual([]);
    expect(mocked.createSessionSandbox).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith(
      "fail_session_job_attempt",
      expect.objectContaining({
        p_job_id: "job-1",
        p_attempt_count: 1,
        p_run_id: undefined,
        p_retry: false,
      }),
    );
    releaseSetup();
    expect((await first).result).toBe("success");
    expect(mocked.openSessionPullRequest).toHaveBeenCalledTimes(1);
  });

  it("stops its sandbox without launching the CLI after ownership is lost during attachments", async () => {
    const { admin, runRows, insertedArtifacts, rpc } = buildAdminMock({ session: baseSession() });
    mocked.materializeSessionAttachments.mockImplementationOnce(async () => {
      runRows[0].status = "canceled";
      return [];
    });

    expect(await processPipelineJob({ admin, job: baseJob() })).toMatchObject({ result: "idle" });
    expect(mocked.createAgentRunner).not.toHaveBeenCalled();
    const sandbox = await mocked.createSessionSandbox.mock.results[0].value;
    expect(sandbox.stop).toHaveBeenCalledOnce();
    expect(insertedArtifacts).toEqual([]);
    expect(rpc.mock.calls.map(([name]) => name)).toEqual(["start_session_job_attempt"]);
  });

  it("fails preparation by captured job and attempt before any run is bound", async () => {
    const { admin, rpc, insertedRuns } = buildAdminMock({ session: baseSession() });
    const job = baseJob({ attempt_count: 2 });
    mocked.loadCompletedStageArtifacts.mockImplementationOnce(async () => {
      job.attempt_count = 3;
      throw new Error("context unavailable");
    });

    expect(await processPipelineJob({ admin, job })).toMatchObject({
      result: "error",
      runId: null,
    });
    expect(rpc.mock.calls).toEqual([
      [
        "fail_session_job_attempt",
        expect.objectContaining({
          p_job_id: "job-1",
          p_attempt_count: 2,
          p_run_id: undefined,
          p_error: "context unavailable",
        }),
      ],
    ]);
    expect(insertedRuns).toEqual([]);
    expect(mocked.createSessionSandbox).not.toHaveBeenCalled();
  });

  it("propagates failure RPC errors without ownerless job or session fallback", async () => {
    const { admin, rpc, updatedJobs, updatedSessions } = buildAdminMock({
      session: baseSession(),
      failRpcError: { message: "failure RPC unavailable" },
    });
    mocked.createAgentRunner.mockReturnValue(
      makeRunner([{ type: "error", message: "agent failed" }]),
    );
    await expect(processPipelineJob({ admin, job: baseJob() })).rejects.toEqual({
      message: "failure RPC unavailable",
    });
    expect(updatedJobs).toEqual([]);
    expect(updatedSessions).toEqual([{ phase_status: "in_progress" }]);
    expect(rpc).toHaveBeenCalledWith(
      "fail_session_job_attempt",
      expect.objectContaining({
        p_job_id: "job-1",
        p_attempt_count: 1,
        p_run_id: "run-1",
      }),
    );
    const sandbox = await mocked.createSessionSandbox.mock.results[0].value;
    expect(sandbox.stop).toHaveBeenCalledOnce();
  });

  it.each(["pull request", "sandbox shutdown"])(
    "preserves successful publication when %s throws",
    async (failure) => {
      const { admin, insertedArtifacts, runRows, updatedJobs, updatedSessions } = buildAdminMock({
        session: baseSession(),
      });
      if (failure === "pull request") {
        mocked.openSessionPullRequest.mockRejectedValueOnce(new Error("GitHub unavailable"));
      } else {
        mocked.createSessionSandbox.mockImplementationOnce(async (input) => {
          await input.onSandboxCreated?.({ provider: "vercel", sandboxId: "sandbox-1" });
          return { stop: vi.fn().mockRejectedValue(new Error("shutdown unavailable")) };
        });
      }
      expect((await processPipelineJob({ admin, job: baseJob() })).result).toBe("success");
      expect(insertedArtifacts).toHaveLength(1);
      expect(runRows[0].status).toBe("success");
      expect(updatedJobs).toEqual([{ status: "success" }]);
      expect(updatedSessions).toEqual([
        { phase_status: "in_progress" },
        { current_artifact_version: 1, phase_status: "awaiting_review" },
      ]);
    },
  );

  it("marks the prepared run errored and stops its sandbox when credential resolution fails", async () => {
    const { createAgentRunner } =
      await vi.importActual<typeof import("@/lib/agent-runner")>("@/lib/agent-runner");
    mocked.createAgentRunner.mockImplementationOnce(createAgentRunner);
    const sandbox = new FakeSandbox();
    vi.spyOn(sandbox, "stop");
    mocked.createSessionSandbox.mockResolvedValueOnce(sandbox);
    mocked.getCodexCredentialForSession.mockRejectedValueOnce(
      new Error("Unsupported state or unable to authenticate data"),
    );
    const session = baseSession();
    const { admin, insertedMessages, insertedRuns, updatedJobs, updatedRuns, updatedSessions } =
      buildAdminMock({
        session,
        agentConfig: [],
      });

    const result = await processPipelineJob({
      admin,
      job: baseJob({ attempt_count: 3 }),
    });

    expect(result).toEqual({
      jobId: "job-1",
      processed: true,
      result: "error",
      runId: "run-1",
    });
    expect(insertedRuns).toHaveLength(0);
    expect(insertedMessages.filter((message) => message.kind !== "progress")).toEqual([
      expect.objectContaining({
        kind: "error",
        message_md: "**Error:** Unsupported state or unable to authenticate data",
      }),
    ]);
    expect(updatedRuns[0]).toMatchObject({ status: "running", model_provider: "codex" });
    expect(updatedRuns.filter((patch) => patch.status === "error")).toEqual([
      expect.objectContaining({ status: "error" }),
    ]);
    expect(sandbox.stop).toHaveBeenCalledOnce();
    expect(mocked.createAgentRunner).toHaveBeenCalledOnce();
    expect(updatedJobs.at(-1)).toMatchObject({
      last_error: "Unsupported state or unable to authenticate data",
      status: "error",
    });
    expect(updatedSessions).toEqual([
      { phase_status: "in_progress" },
      { phase_status: "rejected" },
    ]);
  });

  it("refreshes run activity when runner events are persisted", async () => {
    mocked.createAgentRunner.mockReturnValue(makeRunner([{ type: "text", text: "Spec body" }]));
    const session = baseSession();
    const { admin, updatedRuns, runUpdateFilters } = buildAdminMock({
      session,
      agentConfig: [],
    });

    await processPipelineJob({ admin, job: baseJob() });

    const activityUpdates = updatedRuns.filter((patch) => "last_activity_at" in patch);
    expect(activityUpdates.length).toBeGreaterThan(0);
    expect(
      runUpdateFilters.every((filters) => filters.id === "run-1" && filters.attempt_count === 1),
    ).toBe(true);
    expect(activityUpdates[0]).toEqual({ last_activity_at: expect.any(String) });
    expect(activityUpdates[1]).toEqual({ last_activity_at: expect.any(String) });
  });

  it("fails the stage when persisting a run message fails", async () => {
    mocked.createAgentRunner.mockReturnValue(makeRunner([{ type: "text", text: "Spec body" }]));
    const session = baseSession();
    const {
      admin,
      insertedArtifacts,
      insertedMessages,
      updatedJobs,
      updatedRuns,
      updatedSessions,
    } = buildAdminMock({
      session,
      agentConfig: [],
      messageInsertError: { message: "message insert failed" },
    });

    const result = await processPipelineJob({ admin, job: baseJob({ attempt_count: 3 }) });

    expect(result.result).toBe("error");
    expect(insertedArtifacts).toHaveLength(0);
    expect(insertedMessages).toHaveLength(0);
    expect(updatedRuns.at(-1)).toMatchObject({ status: "error" });
    expect(updatedJobs.at(-1)).toMatchObject({
      last_error: "message insert failed",
      status: "error",
    });
    expect(updatedSessions).toEqual([
      { phase_status: "in_progress" },
      { phase_status: "rejected" },
    ]);
  });

  it.each(
    [
      {
        label: "Codex API key",
        provider: "codex",
        load: mocked.getCodexCredentialForSession,
        credential: { expiresAt: null, secret: "revoked-api-key", type: "platform_api_key" },
      },
      {
        label: "Codex access token",
        provider: "codex",
        load: mocked.getCodexCredentialForSession,
        credential: { expiresAt: null, secret: "revoked-token", type: "codex_access_token" },
      },
      {
        label: "Claude Code",
        provider: "claude-code",
        load: mocked.getClaudeCodeCredentialForSession,
        credential: { secret: "revoked-anthropic-key" },
      },
      {
        label: "Cursor",
        provider: "cursor",
        load: mocked.getCursorCredentialForSession,
        credential: { secret: "revoked-cursor-key", userId: "user-1", generation: "generation-1" },
      },
      {
        label: "OpenCode",
        provider: "opencode",
        load: mocked.getOpenCodeAuthForSession,
        credential: { credential: { secret: "revoked-zen-key" }, providerCredentials: {} },
      },
    ].flatMap((runner) =>
      ["sandbox provisioning", "attachment preparation", "runner preparation"].map((phase) => ({
        ...runner,
        phase,
      })),
    ),
  )("blocks $label credentials revoked during $phase before any agent launch", async (testCase) => {
    let memberActive = true;
    testCase.load.mockImplementationOnce(async () => {
      if (!memberActive) throw new Error("Session owner is no longer an active workspace member.");
      return testCase.credential;
    });
    const { createAgentRunner } =
      await vi.importActual<typeof import("@/lib/agent-runner")>("@/lib/agent-runner");
    mocked.createAgentRunner.mockImplementationOnce(createAgentRunner);
    const sandbox = new FakeSandbox();
    vi.spyOn(sandbox, "stop");
    const writeFile = sandbox.writeFile.bind(sandbox);
    vi.spyOn(sandbox, "writeFile").mockImplementation(async (...args) => {
      await writeFile(...args);
      if (testCase.phase === "runner preparation") memberActive = false;
    });
    mocked.createSessionSandbox.mockImplementationOnce(async (input) => {
      await input.onSandboxCreated?.({ provider: "vercel", sandboxId: sandbox.id });
      if (testCase.phase === "sandbox provisioning") memberActive = false;
      return sandbox;
    });
    mocked.materializeSessionAttachments.mockImplementationOnce(async () => {
      if (testCase.phase === "attachment preparation") memberActive = false;
      return [];
    });
    const { admin, insertedArtifacts, updatedRuns, updatedSessions } = buildAdminMock({
      session: baseSession({ creator_member_id: "member-1" }),
      agentConfig: [
        { key: "agent_provider", value_json: testCase.provider },
        ...(testCase.provider === "opencode"
          ? [{ key: "agent_model", value_json: "opencode/gpt-5.6-sol" }]
          : []),
      ],
    });

    const result = await processPipelineJob({ admin, job: baseJob({ attempt_count: 3 }) });

    expect(memberActive).toBe(false);
    expect(result).toMatchObject({ result: "error", runId: "run-1" });
    expect(testCase.load).toHaveBeenCalledOnce();
    expect(testCase.load.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocked.materializeSessionAttachments.mock.invocationCallOrder[0]!,
    );
    expect(mocked.createAgentRunner).toHaveBeenCalledOnce();
    expect([...sandbox.files.values()].map((file) => file.data.toString())).toEqual([
      "rendered prompt",
    ]);
    expect(sandbox.calls.every((call) => call.args[1]?.startsWith("mkdir -p "))).toBe(true);
    expect(sandbox.stop).toHaveBeenCalledOnce();
    expect(insertedArtifacts).toHaveLength(0);
    expect(updatedRuns.at(-1)).toMatchObject({ status: "error" });
    expect(updatedSessions.at(-1)).toEqual({ phase_status: "rejected" });
  });

  it("resolves the session owner's Anthropic API key for Claude Code runs", async () => {
    const session = baseSession();
    const { admin } = buildAdminMock({
      session,
      agentConfig: [
        { key: "agent_effort", value_json: "max" },
        { key: "agent_provider", value_json: "claude-code" },
        { key: "agent_model", value_json: "claude-sonnet-4-5" },
      ],
    });

    await processPipelineJob({ admin, job: baseJob() });

    expect(mocked.getClaudeCodeCredentialForSession).not.toHaveBeenCalled();
    const options = mocked.createAgentRunner.mock.calls[0]![1] as CreateAgentRunnerOptions;
    await options.claudeCode!.loadCredential!();
    expect(mocked.getClaudeCodeCredentialForSession).toHaveBeenCalledWith(admin, session);
    expect(mocked.createAgentRunner).toHaveBeenCalledWith("claude-code", {
      claudeCode: {
        loadCredential: expect.any(Function),
        effort: "max",
        model: "claude-sonnet-4-5",
      },
    });
  });

  it("preserves the configured effort for Codex runs", async () => {
    const session = baseSession();
    const { admin } = buildAdminMock({
      session,
      agentConfig: [
        { key: "agent_effort", value_json: "max" },
        { key: "agent_provider", value_json: "codex" },
        { key: "agent_model", value_json: "gpt-5.5" },
      ],
    });

    await processPipelineJob({ admin, job: baseJob() });

    expect(mocked.createAgentRunner).toHaveBeenCalledWith("codex", {
      codex: {
        chatGptAuthStore: expect.any(Object),
        loadCredential: expect.any(Function),
        effort: "max",
        model: "gpt-5.5",
      },
    });
  });

  it("resolves the session owner's OpenCode Zen key and persists provider metadata", async () => {
    mocked.createAgentRunner.mockReturnValueOnce(
      makeRunner([{ type: "text", text: "OpenCode artifact" }], { provider: "opencode" }),
    );
    const session = baseSession();
    const { admin, updatedRuns } = buildAdminMock({
      session,
      agentConfig: [
        { key: "agent_provider", value_json: "opencode" },
        { key: "agent_model", value_json: "opencode/gpt-5.6-sol" },
      ],
    });

    await processPipelineJob({ admin, job: baseJob() });

    expect(mocked.getOpenCodeAuthForSession).not.toHaveBeenCalled();
    const options = mocked.createAgentRunner.mock.calls[0]![1] as CreateAgentRunnerOptions;
    await options.openCode!.loadAuth!();
    expect(mocked.getOpenCodeAuthForSession).toHaveBeenCalledWith(
      admin,
      session,
      "opencode/gpt-5.6-sol",
    );
    expect(mocked.createAgentRunner).toHaveBeenCalledWith("opencode", {
      openCode: {
        loadAuth: expect.any(Function),
        model: "opencode/gpt-5.6-sol",
      },
    });
    expect(updatedRuns[0]).toMatchObject({
      model_name: "opencode/gpt-5.6-sol",
      model_provider: "opencode",
    });
  });

  it("resolves a custom OpenCode provider key for the configured model", async () => {
    mocked.getOpenCodeAuthForSession.mockResolvedValueOnce({
      credential: null,
      providerCredentials: { "opencode-go": { secret: "go-test" } },
    });
    mocked.createAgentRunner.mockReturnValueOnce(
      makeRunner([{ type: "text", text: "OpenCode artifact" }], { provider: "opencode" }),
    );
    const session = baseSession();
    const { admin } = buildAdminMock({
      session,
      agentConfig: [
        { key: "agent_provider", value_json: "opencode" },
        { key: "agent_model", value_json: "opencode-go/glm-5.3" },
      ],
    });

    await processPipelineJob({ admin, job: baseJob() });

    expect(mocked.getOpenCodeAuthForSession).not.toHaveBeenCalled();
    const options = mocked.createAgentRunner.mock.calls[0]![1] as CreateAgentRunnerOptions;
    await options.openCode!.loadAuth!();
    expect(mocked.getOpenCodeAuthForSession).toHaveBeenCalledWith(
      admin,
      session,
      "opencode-go/glm-5.3",
    );
    expect(mocked.createAgentRunner).toHaveBeenCalledWith("opencode", {
      openCode: {
        loadAuth: expect.any(Function),
        model: "opencode-go/glm-5.3",
      },
    });
  });

  it("materializes session images and appends typed attachment context to the task", async () => {
    const attachment = {
      contentType: "image/png",
      fileName: "design.png",
      id: "attachment-1",
      position: 1,
      storagePath: "ws-1/attachment-1.png",
    };
    const materialized = {
      contentType: "image/png",
      fileName: "design.png",
      id: "attachment-1",
      position: 1,
      sandboxPath: "/tmp/wallie-session-inputs/1-attachment-1.png",
    };
    mocked.loadSessionAttachmentInputs.mockResolvedValueOnce([attachment]);
    mocked.materializeSessionAttachments.mockResolvedValueOnce([materialized]);
    mocked.formatSessionAttachmentPromptData.mockReturnValueOnce(
      "1. design.png -> /tmp/wallie-session-inputs/1-attachment-1.png",
    );
    const { admin } = buildAdminMock({ session: baseSession() });

    const result = await processPipelineJob({ admin, job: baseJob() });

    expect(result.result).toBe("success");
    expect(mocked.materializeSessionAttachments).toHaveBeenCalledWith(
      admin,
      expect.objectContaining({ repoPath: "/vercel/sandbox" }),
      [attachment],
    );
    expect(mocked.renderStagePrompt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        sessionAttachmentInstructions: expect.objectContaining({
          source: "session.attachmentInstructions",
          trust: "trusted",
        }),
        sessionAttachments: expect.objectContaining({
          source: "session.attachments",
          trust: "untrusted",
          value: "1. design.png -> /tmp/wallie-session-inputs/1-attachment-1.png",
        }),
      }),
    );
  });

  it("opens a session pull request after the artifact is persisted", async () => {
    const session = baseSession();
    const job = baseJob();
    const { admin } = buildAdminMock({ session });

    await processPipelineJob({ admin, job });

    expect(mocked.openSessionPullRequest).toHaveBeenCalledTimes(1);
    const call = mocked.openSessionPullRequest.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.baseBranch).toBe("main");
    expect(call.repoFullName).toBe("acme/app");
    expect(call.repoId).toBe("repo-1");
    expect(call.installationId).toBe(123);
    expect(call.sessionId).toBe(session.id);
    expect(call.workspaceId).toBe(session.workspace_id);
    expect(typeof call.branch).toBe("string");
    expect((call.branch as string).startsWith("wallie/")).toBe(true);
    expect(call.branch).toBe(`wallie/product-${session.id}-job-job-1-attempt-1`);
    expect(call.title).toBe(`${productStage.name}: ${session.title}`);
    expect(call.body).toContain("Drafted spec body");
  });

  it("uses the selected saved repository profile before alphabetical fallback", async () => {
    const session = baseSession();
    const job = baseJob();
    const { admin } = buildAdminMock({
      session,
      githubRepositories: [
        {
          default_branch: "main",
          full_name: "acme/aaa",
          github_installation_id: "ghi-1",
          id: "repo-a",
          is_archived: false,
        },
        {
          default_branch: "trunk",
          full_name: "acme/zzz",
          github_installation_id: "ghi-1",
          id: "repo-z",
          is_archived: false,
        },
      ],
      primaryRepositoryProfile: { github_repository_id: "repo-z" },
    });

    await processPipelineJob({ admin, job });

    const call = mocked.openSessionPullRequest.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.baseBranch).toBe("trunk");
    expect(call.repoFullName).toBe("acme/zzz");
    expect(call.repoId).toBe("repo-z");
  });

  it("does not fall back to another repository when the selected saved repository is archived", async () => {
    const session = baseSession();
    const job = baseJob();
    const { admin } = buildAdminMock({
      session,
      githubRepositories: [
        {
          default_branch: "main",
          full_name: "acme/aaa",
          github_installation_id: "ghi-1",
          id: "repo-a",
          is_archived: false,
        },
        {
          default_branch: "trunk",
          full_name: "acme/zzz",
          github_installation_id: "ghi-1",
          id: "repo-z",
          is_archived: false,
        },
        {
          default_branch: "main",
          full_name: "acme/selected-but-archived",
          github_installation_id: "ghi-1",
          id: "repo-archived",
          is_archived: true,
        },
      ],
      primaryRepositoryProfile: { github_repository_id: "repo-archived" },
    });

    const result = await processPipelineJob({ admin, job });

    expect(result.result).toBe("error");
    expect(mocked.openSessionPullRequest).not.toHaveBeenCalled();
  });

  it("does not abort the stage when opening the pull request fails", async () => {
    mocked.openSessionPullRequest.mockResolvedValueOnce({
      kind: "pr_failed",
      reason: "boom",
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const session = baseSession();
    const { admin, insertedArtifacts, updatedSessions } = buildAdminMock({ session });

    const result = await processPipelineJob({ admin, job: baseJob() });

    expect(insertedArtifacts).toHaveLength(1);
    expect(updatedSessions).toEqual([
      { phase_status: "in_progress" },
      { current_artifact_version: 1, phase_status: "awaiting_review" },
    ]);
    expect(result.result).toBe("success");
    consoleError.mockRestore();
  });

  it("does not persist the stage completion message when artifact persistence fails", async () => {
    const session = baseSession();
    const { admin, insertedMessages, updatedRuns, updatedSessions } = buildAdminMock({
      session,
      artifactInsertError: { message: "artifact insert failed" },
    });

    const result = await processPipelineJob({ admin, job: baseJob({ attempt_count: 3 }) });

    expect(result.result).toBe("error");
    expect(insertedMessages.filter((message) => message.kind !== "progress")).toEqual([
      expect.objectContaining({
        kind: "text",
        message_md: "Drafted spec body",
      }),
      expect.objectContaining({
        kind: "completion",
        message_md: "Done",
      }),
      expect.objectContaining({
        kind: "error",
        message_md: "**Error:** artifact insert failed",
      }),
    ]);
    expect(insertedMessages).not.toContainEqual(
      expect.objectContaining({
        message_md: "Product run completed",
      }),
    );
    expect(updatedRuns.at(-1)).toMatchObject({ status: "error" });
    expect(updatedSessions).toEqual([
      { phase_status: "in_progress" },
      { phase_status: "rejected" },
    ]);
  });

  it("preserves publication when completion logging fails after stage advancement", async () => {
    const session = baseSession({ current_artifact_version: 2 });
    const {
      admin,
      insertedArtifacts,
      updatedJobs,
      updatedRuns,
      updatedSessions,
      legacyMutationCalls,
      rpc,
    } = buildAdminMock({
      session,
      messageInsertError: { message: "completion insert failed" },
      messageInsertErrorOnMessage: "Product run completed",
    });
    mocked.openSessionPullRequest.mockImplementationOnce(async () => {
      session.current_stage_id = "stage-build";
      session.current_artifact_version = 0;
      session.phase_status = "in_progress";
      return { kind: "success", prNumber: 42 };
    });
    const result = await processPipelineJob({ admin, job: baseJob({ attempt_count: 3 }) });
    expect(result.result).toBe("success");
    expect(insertedArtifacts[0]).toMatchObject({ version: 3 });
    expect(legacyMutationCalls).toEqual([]);
    expect(updatedRuns.at(-1)).toMatchObject({ status: "success" });
    expect(updatedJobs.at(-1)).toMatchObject({ status: "success" });
    expect(updatedSessions).toEqual([
      { phase_status: "in_progress" },
      { current_artifact_version: 3, phase_status: "awaiting_review" },
    ]);
    expect(session).toMatchObject({
      current_stage_id: "stage-build",
      current_artifact_version: 0,
      phase_status: "in_progress",
    });
    expect(rpc).toHaveBeenCalledWith(
      "fail_session_job_attempt",
      expect.objectContaining({ p_job_id: "job-1", p_attempt_count: 3, p_run_id: "run-1" }),
    );
  });

  it("retires a refused startup by captured claim without guessing a run", async () => {
    const { admin, rpc } = buildAdminMock({
      session: baseSession({ phase_status: "approved" }),
      claimSucceeds: false,
    });
    const result = await processPipelineJob({ admin, job: baseJob() });
    expect(mocked.renderStagePrompt).not.toHaveBeenCalled();
    expect(mocked.createSessionSandbox).not.toHaveBeenCalled();
    expect(result).toMatchObject({ result: "idle", runId: null });
    expect(rpc).toHaveBeenCalledWith(
      "fail_session_job_attempt",
      expect.objectContaining({
        p_job_id: "job-1",
        p_attempt_count: 1,
        p_run_id: undefined,
        p_retry: false,
      }),
    );
  });

  it("errors when a sandbox-required runner has no GitHub installation for the workspace", async () => {
    const session = baseSession();
    const { admin, insertedMessages, updatedSessions } = buildAdminMock({
      session,
      githubInstallation: null,
    });
    const result = await processPipelineJob({ admin, job: baseJob() });
    expect(result.result).toBe("error");
    expect(insertedMessages.filter((message) => message.kind !== "progress")).toEqual([
      expect.objectContaining({
        kind: "error",
        message_md:
          "**Error:** No GitHub installation or repository found for workspace. Connect a GitHub repository in workspace settings.",
      }),
    ]);
    expect(mocked.createSessionSandbox).not.toHaveBeenCalled();
    expect(mocked.openSessionPullRequest).not.toHaveBeenCalled();
    expect(mocked.renderStagePrompt).not.toHaveBeenCalled();
    expect(updatedSessions).toEqual([
      { phase_status: "in_progress" },
      { phase_status: "rejected" },
    ]);
  });

  it("aborts before sandbox creation when the sandbox connection is not connected", async () => {
    const error = new Error("Connect a Vercel Sandbox account before starting Wallie runs.");
    error.name = "SandboxConnectionMissingError";
    mocked.loadRequiredWorkspaceSandboxConnection.mockRejectedValueOnce(error);
    const session = baseSession();
    const { admin, insertedArtifacts, insertedMessages, rpc, updatedJobs, updatedSessions } =
      buildAdminMock({
        session,
      });

    const result = await processPipelineJob({ admin, job: baseJob() });

    expect(result.result).toBe("error");
    expect(insertedArtifacts).toHaveLength(0);
    expect(insertedMessages.filter((message) => message.kind !== "progress")).toEqual([
      expect.objectContaining({
        kind: "error",
        message_md: "**Error:** Connect a Vercel Sandbox account before starting Wallie runs.",
      }),
    ]);
    expect(mocked.createSessionSandbox).not.toHaveBeenCalled();
    expect(updatedSessions).toEqual([
      { phase_status: "in_progress" },
      { phase_status: "rejected" },
    ]);
    expect(rpc).not.toHaveBeenCalledWith("schedule_job_retry", expect.anything());
    expect(updatedJobs.at(-1)).toMatchObject({
      last_error: "Connect a Vercel Sandbox account before starting Wallie runs.",
      status: "error",
    });
  });

  it("aborts before sandbox creation when the selected provider capability check is stale", async () => {
    const error = new Error("Run a successful E2B capability check before starting Wallie.");
    error.name = "SandboxCapabilityCheckStaleError";
    mocked.assertCurrentSandboxCapabilityCheck.mockRejectedValueOnce(error);
    const session = baseSession();
    const { admin, insertedArtifacts, updatedJobs } = buildAdminMock({ session });

    const result = await processPipelineJob({ admin, job: baseJob() });

    expect(result.result).toBe("error");
    expect(insertedArtifacts).toHaveLength(0);
    expect(mocked.createSessionSandbox).not.toHaveBeenCalled();
    expect(updatedJobs.at(-1)).toMatchObject({
      last_error: "Run a successful E2B capability check before starting Wallie.",
      status: "error",
    });
  });

  it("does not require a Vercel connection when fake sandbox execution is selected", async () => {
    mocked.resolveSandboxImplementation.mockReturnValueOnce("fake");
    mocked.createSessionSandbox.mockImplementationOnce(async (input) => {
      await input.onSandboxCreated?.({ provider: "fake", sandboxId: "fake-sandbox-1" });
      return {
        id: "fake-sandbox-1",
        repoPath: "/tmp/wallie-fake-sandbox",
        exec: vi.fn(),
        readFile: vi.fn(),
        stop: vi.fn().mockResolvedValue(undefined),
        writeFile: vi.fn(),
      };
    });
    const session = baseSession();
    const { admin, updatedRuns } = buildAdminMock({ session });

    const result = await processPipelineJob({ admin, job: baseJob() });

    expect(result.result).toBe("success");
    expect(mocked.loadRequiredWorkspaceSandboxConnection).not.toHaveBeenCalled();
    expect(mocked.assertCurrentSandboxCapabilityCheck).not.toHaveBeenCalled();
    expect(mocked.createSessionSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        implementation: "fake",
        connection: undefined,
      }),
    );
    expect(updatedRuns).toContainEqual({
      sandbox_connection_revision: null,
      sandbox_id: "fake-sandbox-1",
      sandbox_provider: "fake",
      sandbox_vercel_project_id: null,
      sandbox_vercel_team_id: null,
    });
  });

  it("aborts the stage and flips status to rejected when sandbox provisioning fails", async () => {
    mocked.createSessionSandbox.mockRejectedValueOnce(
      new Error(
        "vercel sandbox unavailable: https://wallie:secret-token@example.com/run?token=vca_12345678901234567890",
      ),
    );
    const session = baseSession();
    const { admin, insertedArtifacts, insertedMessages, updatedSessions } = buildAdminMock({
      session,
    });

    const result = await processPipelineJob({ admin, job: baseJob() });

    expect(result.result).toBe("error");
    expect(insertedArtifacts).toHaveLength(0);
    expect(insertedMessages.filter((message) => message.kind !== "progress")).toEqual([
      expect.objectContaining({
        kind: "error",
        message_md:
          "**Error:** vercel sandbox unavailable: https://[redacted]@example.com/run?token=[redacted]",
      }),
    ]);
    expect(mocked.openSessionPullRequest).not.toHaveBeenCalled();
    expect(updatedSessions).toEqual([
      { phase_status: "in_progress" },
      { phase_status: "rejected" },
    ]);
  });

  it("redacts multiline secret diagnostics before persisting sandbox failures", async () => {
    mocked.createSessionSandbox.mockRejectedValueOnce(
      new Error(
        [
          "sandbox failed while loading env",
          'PRIVATE_KEY="-----BEGIN PRIVATE KEY-----',
          "abc def ghi",
          '-----END PRIVATE KEY-----"',
          "ACCESS_TOKEN=first second third",
          "Retry after reconnecting.",
        ].join("\n"),
      ),
    );
    const session = baseSession();
    const { admin, insertedMessages } = buildAdminMock({ session });

    const result = await processPipelineJob({ admin, job: baseJob() });

    expect(result.result).toBe("error");
    expect(insertedMessages.filter((message) => message.kind !== "progress")).toEqual([
      expect.objectContaining({
        kind: "error",
        message_md: [
          "**Error:** sandbox failed while loading env",
          'PRIVATE_KEY="[redacted]"',
          "ACCESS_TOKEN=[redacted]",
          "Retry after reconnecting.",
        ].join("\n"),
      }),
    ]);
    expect(insertedMessages.find((message) => message.kind === "error")!.message_md).not.toContain(
      "BEGIN PRIVATE KEY",
    );
    expect(insertedMessages.find((message) => message.kind === "error")!.message_md).not.toContain(
      "abc def ghi",
    );
    expect(insertedMessages.find((message) => message.kind === "error")!.message_md).not.toContain(
      "first second third",
    );
  });

  it("redacts escaped quoted secret assignments before persisting sandbox failures", async () => {
    mocked.createSessionSandbox.mockRejectedValueOnce(
      new Error(
        'sandbox failed while loading env\nAPI_KEY="abc\\"def-secret"\nRetry after reconnecting.',
      ),
    );
    const session = baseSession();
    const { admin, insertedMessages } = buildAdminMock({ session });

    const result = await processPipelineJob({ admin, job: baseJob() });

    expect(result.result).toBe("error");
    expect(insertedMessages.filter((message) => message.kind !== "progress")).toEqual([
      expect.objectContaining({
        kind: "error",
        message_md: [
          "**Error:** sandbox failed while loading env",
          'API_KEY="[redacted]"',
          "Retry after reconnecting.",
        ].join("\n"),
      }),
    ]);
    expect(insertedMessages.find((message) => message.kind === "error")!.message_md).not.toContain(
      "abc",
    );
    expect(insertedMessages.find((message) => message.kind === "error")!.message_md).not.toContain(
      "def-secret",
    );
  });

  it("redacts quoted JSON secret fields before persisting sandbox failures", async () => {
    mocked.createSessionSandbox.mockRejectedValueOnce(
      new Error(
        'sandbox config rejected: {"token":"plain-secret-12345","password":"hunter2","safe":"visible"}',
      ),
    );
    const session = baseSession();
    const { admin, insertedMessages } = buildAdminMock({ session });

    const result = await processPipelineJob({ admin, job: baseJob() });

    expect(result.result).toBe("error");
    expect(insertedMessages.filter((message) => message.kind !== "progress")).toEqual([
      expect.objectContaining({
        kind: "error",
        message_md:
          '**Error:** sandbox config rejected: {"token": "[redacted]","password": "[redacted]","safe":"visible"}',
      }),
    ]);
    expect(insertedMessages.find((message) => message.kind === "error")!.message_md).not.toContain(
      "plain-secret-12345",
    );
    expect(insertedMessages.find((message) => message.kind === "error")!.message_md).not.toContain(
      "hunter2",
    );
    expect(insertedMessages.find((message) => message.kind === "error")!.message_md).toContain(
      '"safe":"visible"',
    );
  });

  it("redacts camelCase JSON secret fields before persisting sandbox failures", async () => {
    mocked.createSessionSandbox.mockRejectedValueOnce(
      new Error(
        'sandbox config rejected: {"apiKey":"plain-api-key","privateKey":"plain-private-key","clientSecret":"plain-client-secret","safe":"visible"}',
      ),
    );
    const session = baseSession();
    const { admin, insertedMessages } = buildAdminMock({ session });

    const result = await processPipelineJob({ admin, job: baseJob() });

    expect(result.result).toBe("error");
    expect(insertedMessages.filter((message) => message.kind !== "progress")).toEqual([
      expect.objectContaining({
        kind: "error",
        message_md:
          '**Error:** sandbox config rejected: {"apiKey": "[redacted]","privateKey": "[redacted]","clientSecret": "[redacted]","safe":"visible"}',
      }),
    ]);
    expect(insertedMessages.find((message) => message.kind === "error")!.message_md).not.toContain(
      "plain-api-key",
    );
    expect(insertedMessages.find((message) => message.kind === "error")!.message_md).not.toContain(
      "plain-private-key",
    );
    expect(insertedMessages.find((message) => message.kind === "error")!.message_md).not.toContain(
      "plain-client-secret",
    );
    expect(insertedMessages.find((message) => message.kind === "error")!.message_md).toContain(
      '"safe":"visible"',
    );
  });

  it("redacts object-valued JSON secret fields before persisting sandbox failures", async () => {
    mocked.createSessionSandbox.mockRejectedValueOnce(
      new Error(
        'sandbox config rejected: {"token":{"value":"plain-secret-12345"},"privateKey":["line1","line2"],"safe":"visible"}',
      ),
    );
    const session = baseSession();
    const { admin, insertedMessages } = buildAdminMock({ session });

    const result = await processPipelineJob({ admin, job: baseJob() });

    expect(result.result).toBe("error");
    expect(insertedMessages.filter((message) => message.kind !== "progress")).toEqual([
      expect.objectContaining({
        kind: "error",
        message_md:
          '**Error:** sandbox config rejected: {"token": "[redacted]","privateKey": "[redacted]","safe":"visible"}',
      }),
    ]);
    expect(insertedMessages.find((message) => message.kind === "error")!.message_md).not.toContain(
      "plain-secret-12345",
    );
    expect(insertedMessages.find((message) => message.kind === "error")!.message_md).not.toContain(
      "line1",
    );
    expect(insertedMessages.find((message) => message.kind === "error")!.message_md).not.toContain(
      "line2",
    );
    expect(insertedMessages.find((message) => message.kind === "error")!.message_md).toContain(
      '"safe":"visible"',
    );
  });

  it("aborts the stage when persisting the sandbox id fails", async () => {
    const session = baseSession();
    const { admin, insertedArtifacts, insertedMessages, updatedRuns, updatedSessions } =
      buildAdminMock({
        session,
        runSandboxUpdateError: { message: "sandbox id write failed" },
      });

    const result = await processPipelineJob({ admin, job: baseJob() });

    expect(result.result).toBe("error");
    expect(result.runId).toBe("run-1");
    expect(insertedArtifacts).toHaveLength(0);
    expect(insertedMessages.filter((message) => message.kind !== "progress")).toEqual([
      expect.objectContaining({
        kind: "error",
        message_md: "**Error:** sandbox id write failed",
      }),
    ]);
    expect(mocked.openSessionPullRequest).not.toHaveBeenCalled();
    expect(updatedRuns.find((patch) => "sandbox_id" in patch)).toEqual({
      sandbox_connection_revision: "revision-1",
      sandbox_id: "sandbox-1",
      sandbox_provider: "vercel",
      sandbox_vercel_project_id: "prj_123",
      sandbox_vercel_team_id: "team_123",
    });
    expect(updatedRuns.at(-1)).toMatchObject({ status: "error" });
    expect(updatedSessions).toEqual([
      { phase_status: "in_progress" },
      { phase_status: "rejected" },
    ]);
  });

  it("swallows diagnostic insert failures and preserves sandbox failure handling", async () => {
    mocked.createSessionSandbox.mockRejectedValueOnce(new Error("vercel sandbox unavailable"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const session = baseSession();
    const { admin, insertedArtifacts, insertedMessages, updatedJobs, updatedSessions } =
      buildAdminMock({
        session,
        messageInsertError: { message: "diagnostic insert failed" },
      });

    const result = await processPipelineJob({ admin, job: baseJob({ attempt_count: 3 }) });

    expect(result.result).toBe("error");
    expect(insertedArtifacts).toHaveLength(0);
    expect(insertedMessages).toHaveLength(0);
    expect(updatedJobs.at(-1)).toMatchObject({
      last_error: "vercel sandbox unavailable",
      status: "error",
    });
    expect(updatedSessions).toEqual([
      { phase_status: "in_progress" },
      { phase_status: "rejected" },
    ]);
    consoleError.mockRestore();
  });

  it("fails the owned attempt on an agent error before any artifact is published", async () => {
    mocked.createAgentRunner.mockReturnValue(
      makeRunner([
        { type: "text", text: "partial output" },
        { type: "error", message: "rate limited" },
      ]),
    );
    const session = baseSession();
    const { admin, insertedArtifacts, insertedMessages, updatedSessions } = buildAdminMock({
      session,
    });

    const result = await processPipelineJob({ admin, job: baseJob() });

    expect(result.result).toBe("error");
    expect(insertedArtifacts).toHaveLength(0);
    expect(insertedMessages.filter((message) => message.kind !== "progress")).toEqual([
      expect.objectContaining({
        kind: "text",
        message_md: "partial output",
      }),
      expect.objectContaining({
        kind: "error",
        message_md: "**Error:** rate limited",
      }),
    ]);
    expect(mocked.openSessionPullRequest).not.toHaveBeenCalled();
    expect(updatedSessions).toEqual([
      { phase_status: "in_progress" },
      { phase_status: "rejected" },
    ]);
  });
});

// ---- handleApproval -----------------------------------------------------

/**
 * Admin mock for the post-approval enqueue: the approval RPC itself is stubbed
 * via `rpc`, and the tables below are exactly those the shared
 * `enqueueSessionJobWithRun` path touches (effective-repository resolution,
 * atomic enqueue receipt, and returned run lookup).
 */
function buildApprovalEnqueueMock(opts: {
  adoptExisting: boolean;
  rpc: (fn: string, args?: unknown) => unknown;
}) {
  const enqueuedJobs: Array<Record<string, unknown>> = [];
  const insertedRuns: Array<Record<string, unknown>> = [];

  const tables: Record<string, unknown> = {
    agent_runs: {
      insert: (row: Record<string, unknown>) => {
        insertedRuns.push(row);
        return {
          select: () => ({
            single: async () => ({ data: { ...row, id: "run-next" }, error: null }),
          }),
        };
      },
      select: () => {
        const chain = {
          abortSignal: () => chain,
          eq: () => chain,
          limit: () => chain,
          maybeSingle: async () => ({
            data: { agent_job_id: "job-active", id: "run-active" },
            error: null,
          }),
          order: () => chain,
        };
        return chain;
      },
    },
    sessions: {
      select: () => {
        const builder = {
          eq: () => builder,
          maybeSingle: async () => ({
            data: baseSession({ current_stage_id: "stage-design" }),
            error: null,
          }),
        };
        return builder;
      },
    },
    session_pull_requests: {
      select: () => ({
        eq: () => ({
          eq: () => ({
            order: () => ({
              limit: () => ({
                maybeSingle: async () => ({ data: null, error: null }),
              }),
            }),
          }),
        }),
      }),
    },
    workspace_agent_config: {
      select: () => ({
        eq: () => ({
          in: async () => ({ data: [], error: null }),
        }),
      }),
    },
    workspace_onboarding: {
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: null, error: null }),
        }),
      }),
    },
    workspace_repository_profiles: {
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: null, error: null }),
          }),
        }),
      }),
    },
  };

  return {
    admin: createProcessorTestAdminClient({
      from: (name: string) => tables[name] ?? {},
      rpc: (name, args) => {
        if (name !== "enqueue_session_job_with_run") return opts.rpc(name, args);
        enqueuedJobs.push(args as Record<string, unknown>);
        return Promise.resolve({
          data: [
            {
              created: !opts.adoptExisting,
              job_id: opts.adoptExisting ? "job-active" : "job-next",
              run_id: opts.adoptExisting ? "run-active" : "run-next",
            },
          ],
          error: null,
        });
      },
    }),
    enqueuedJobs,
    insertedRuns,
  };
}

describe("handleApproval", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked.loadWorkspaceAgentConfig.mockResolvedValue({
      effort: "xhigh",
      model: "gpt-5.5",
      provider: "codex",
    });
  });

  it("calls approve_session_stage with the approver id and returns success on a non-empty result", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [{ id: "sess-1", current_stage_id: "stage-design" }],
      error: null,
    });
    const admin = createProcessorTestAdminClient({ from: () => ({}), rpc });
    const result = await handleApproval({
      admin,
      approverMemberId: "mem-1",
      expectedWorkspaceId: "ws-1",
      sessionId: "sess-1",
      version: 1,
    });
    expect(rpc).toHaveBeenCalledWith("approve_session_stage", {
      approver_member_id: "mem-1",
      expected_version: 1,
      expected_workspace_id: "ws-1",
      target_session_id: "sess-1",
    });
    expect(result.success).toBe(true);
  });

  it("returns an authorization error when the RPC returns an empty result", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [], error: null });
    const result = await handleApproval({
      admin: createProcessorTestAdminClient({ from: () => ({}), rpc }),
      approverMemberId: null,
      expectedWorkspaceId: "ws-1",
      sessionId: "sess-1",
      version: 1,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("not authorized");
  });

  it("queues the next stage through the shared job-with-run enqueue path", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [
        {
          archived_at: null,
          current_stage_id: "stage-design",
          id: "sess-1",
          phase_status: "in_progress",
        },
      ],
      error: null,
    });
    const { admin, enqueuedJobs, insertedRuns } = buildApprovalEnqueueMock({
      adoptExisting: false,
      rpc,
    });

    const result = await handleApproval({
      admin,
      approverMemberId: "mem-1",
      expectedWorkspaceId: "ws-1",
      sessionId: "sess-1",
      version: 1,
    });

    expect(result).toEqual({
      jobId: "job-next",
      session: {
        archivedAt: null,
        currentArtifactVersion: 0,
        currentStageId: "stage-design",
        phaseStatus: "in_progress",
        rejectionCount: 0,
      },
      success: true,
    });
    // Approval passes the expected next stage and configured run to one enqueue RPC.
    expect(enqueuedJobs).toEqual([
      {
        p_session_id: "sess-1",
        p_workspace_id: "ws-1",
        p_expected_stage_id: "stage-design",
        p_requested_by_member_id: "mem-1",
        p_trigger_type: "assignment",
        p_agent_model_provider: "codex",
        p_agent_model_name: "gpt-5.5",
        p_run_type: "project",
      },
    ]);
    expect(insertedRuns).toEqual([]);
  });

  it("reports the live job when the next-stage enqueue loses the dedupe race", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [
        {
          archived_at: null,
          current_stage_id: "stage-design",
          id: "sess-1",
          phase_status: "in_progress",
        },
      ],
      error: null,
    });
    const { admin, insertedRuns } = buildApprovalEnqueueMock({
      adoptExisting: true,
      rpc,
    });

    const result = await handleApproval({
      admin,
      approverMemberId: "mem-1",
      expectedWorkspaceId: "ws-1",
      sessionId: "sess-1",
      version: 1,
    });

    expect(result.success).toBe(true);
    expect(result.jobId).toBe("job-active");
    // No second run is inserted for the job that already exists.
    expect(insertedRuns).toEqual([]);
  });

  it("keeps approval successful when automatic enqueue fails after the stage RPC commits", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const rpc = vi.fn().mockResolvedValueOnce({
      data: [
        {
          archived_at: null,
          current_stage_id: "stage-design",
          id: "sess-1",
          phase_status: "in_progress",
        },
      ],
      error: null,
    });
    const enqueueError = {
      code: "deadlock",
      message: "queue write failed",
    };
    rpc.mockResolvedValue({ data: null, error: enqueueError });
    const tables: Record<string, unknown> = {
      agent_jobs: {
        insert: () => ({
          select: () => ({
            single: async () => ({
              data: null,
              error: enqueueError,
            }),
          }),
        }),
      },
      pipeline_stages: {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: { id: "stage-design", name: "Design", slug: "design" },
              error: null,
            }),
          }),
        }),
      },
      sessions: {
        select: () => {
          const builder = {
            eq: () => builder,
            maybeSingle: async () => ({
              data: baseSession({ current_stage_id: "stage-design" }),
              error: null,
            }),
          };
          return builder;
        },
      },
      session_pull_requests: {
        select: () => ({
          eq: () => ({
            eq: () => ({
              order: () => ({
                limit: () => ({
                  maybeSingle: async () => ({ data: null, error: null }),
                }),
              }),
            }),
          }),
        }),
      },
      workspace_agent_config: {
        select: () => ({
          eq: () => ({
            in: async () => ({ data: [], error: null }),
          }),
        }),
      },
      workspace_onboarding: {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: null, error: null }),
          }),
        }),
      },
      workspace_repository_profiles: {
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: null, error: null }),
            }),
          }),
        }),
      },
    };
    const admin = createProcessorTestAdminClient({
      from: (name: string) => tables[name] ?? {},
      rpc,
    });

    const result = await handleApproval({
      admin,
      approverMemberId: "mem-1",
      expectedWorkspaceId: "ws-1",
      sessionId: "sess-1",
      version: 1,
    });

    expect(result).toEqual({
      jobId: null,
      session: {
        archivedAt: null,
        currentArtifactVersion: 0,
        currentStageId: "stage-design",
        phaseStatus: "in_progress",
        rejectionCount: 0,
      },
      success: true,
    });
    expect(consoleError).toHaveBeenCalledWith(
      "Approved stage but failed to queue Wallie",
      expect.objectContaining({
        error: "queue write failed",
        sessionId: "sess-1",
        workspaceId: "ws-1",
      }),
    );

    consoleError.mockRestore();
  });
});

// ---- handleRejection ----------------------------------------------------

interface RejectionMockOptions {
  rpcResult?: { data: unknown; error: { code?: string; message: string } | null };
  /** Repository the session's pull request resolves to; drives the run mode. */
  sessionPullRequestRepositoryId?: string | null;
}

function rejectedSessionRow(overrides: Record<string, unknown> = {}) {
  return {
    archived_at: null,
    current_artifact_version: 1,
    current_stage_id: "stage-product",
    job_created: true,
    job_id: "job-retry",
    phase_status: "rejected",
    rejection_count: 1,
    run_id: "run-retry",
    session_id: "sess-1",
    workspace_id: "ws-1",
    ...overrides,
  };
}

// Rejection is a single RPC. The only table reads left in the TypeScript path
// resolve the queued run's model + run mode (`resolveQueuedRunConfig`), which
// walks the effective-repository lookup before the RPC is called.
function buildRejectionMock(opts: RejectionMockOptions = {}) {
  const rpc = vi
    .fn()
    .mockResolvedValue(opts.rpcResult ?? { data: [rejectedSessionRow()], error: null });

  const sessionPullRequestsTable = {
    select: () => ({
      eq: () => ({
        eq: () => ({
          order: () => ({
            limit: () => ({
              maybeSingle: async () => ({
                data:
                  opts.sessionPullRequestRepositoryId === undefined ||
                  opts.sessionPullRequestRepositoryId === null
                    ? null
                    : { github_repository_id: opts.sessionPullRequestRepositoryId },
                error: null,
              }),
            }),
          }),
        }),
      }),
    }),
  };

  const githubRepositoriesTable = {
    select: () => ({
      eq: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: opts.sessionPullRequestRepositoryId
              ? {
                  default_branch: "main",
                  default_programming_language: null,
                  full_name: "acme/app",
                  github_installation_id: "inst-1",
                  html_url: "https://github.com/acme/app",
                  id: opts.sessionPullRequestRepositoryId,
                  is_archived: false,
                  private: false,
                  workspace_id: "ws-1",
                }
              : null,
            error: null,
          }),
        }),
      }),
    }),
  };

  const workspaceRepositoryProfilesTable = {
    select: () => ({
      eq: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: null, error: null }),
        }),
      }),
    }),
  };

  const workspaceOnboardingTable = {
    select: () => ({
      eq: () => ({
        maybeSingle: async () => ({ data: null, error: null }),
      }),
    }),
  };

  // Only the effective-repository lookup reads the session now; the RPC owns
  // every guard that used to need the full row.
  const sessionsTable = {
    select: () => {
      const builder = {
        eq: () => builder,
        maybeSingle: async () => ({ data: { github_repository_id: null }, error: null }),
      };
      return builder;
    },
  };

  const tables: Record<string, unknown> = {
    github_repositories: githubRepositoriesTable,
    session_pull_requests: sessionPullRequestsTable,
    sessions: sessionsTable,
    workspace_onboarding: workspaceOnboardingTable,
    workspace_repository_profiles: workspaceRepositoryProfilesTable,
  };

  return {
    admin: createProcessorTestAdminClient({
      from: (name: string) => tables[name] ?? {},
      rpc,
    }),
    rpc,
  };
}

describe("handleRejection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked.loadWorkspaceAgentConfig.mockResolvedValue({
      effort: "xhigh",
      model: "gpt-5.5",
      provider: "codex",
    });
  });

  it("rejects through the reject_session_stage RPC with the reviewer, version, feedback, and queued-run config", async () => {
    const { admin, rpc } = buildRejectionMock();

    const result = await handleRejection({
      admin,
      expectedWorkspaceId: "ws-1",
      feedbackText: "tighten the spec",
      requestedByMemberId: "mem-reviewer",
      sessionId: "sess-1",
      version: 1,
    });

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("reject_session_stage", {
      p_agent_model_name: "gpt-5.5",
      p_agent_model_provider: "codex",
      p_artifact_version: 1,
      p_feedback_text: "tighten the spec",
      p_requested_by_member_id: "mem-reviewer",
      p_run_type: "project",
      p_session_id: "sess-1",
      p_workspace_id: "ws-1",
    });
    expect(result).toEqual({
      jobId: "job-retry",
      session: {
        archivedAt: null,
        currentArtifactVersion: 1,
        currentStageId: "stage-product",
        phaseStatus: "rejected",
        rejectionCount: 1,
      },
      success: true,
    });
  });

  it("stamps the code run mode when the session's pull request resolves to a repository", async () => {
    const { admin, rpc } = buildRejectionMock({ sessionPullRequestRepositoryId: "repo-1" });

    const result = await handleRejection({
      admin,
      expectedWorkspaceId: "ws-1",
      feedbackText: "needs tests",
      requestedByMemberId: "mem-reviewer",
      sessionId: "sess-1",
      version: 1,
    });

    expect(result.success).toBe(true);
    expect(rpc).toHaveBeenCalledWith(
      "reject_session_stage",
      expect.objectContaining({ p_run_type: "code" }),
    );
  });

  it("omits the reviewer when no member id is available", async () => {
    const { admin, rpc } = buildRejectionMock();

    await handleRejection({
      admin,
      expectedWorkspaceId: "ws-1",
      feedbackText: "needs work",
      requestedByMemberId: null,
      sessionId: "sess-1",
      version: 1,
    });

    expect(rpc).toHaveBeenCalledWith(
      "reject_session_stage",
      expect.objectContaining({ p_requested_by_member_id: undefined }),
    );
  });

  it("reports the adopted job when the RPC deduped against an already-active job", async () => {
    const { admin } = buildRejectionMock({
      rpcResult: {
        data: [
          rejectedSessionRow({ job_created: false, job_id: "job-retry-existing", run_id: null }),
        ],
        error: null,
      },
    });

    const result = await handleRejection({
      admin,
      expectedWorkspaceId: "ws-1",
      feedbackText: "again",
      requestedByMemberId: "mem-reviewer",
      sessionId: "sess-1",
      version: 1,
    });

    expect(result.success).toBe(true);
    expect(result.jobId).toBe("job-retry-existing");
    expect(result.session?.phaseStatus).toBe("rejected");
  });

  it.each([
    ["P0002", "Session not found."],
    ["55000", "Session is archived."],
    ["55000", "Session is not awaiting review."],
    ["55000", "Version mismatch: a newer version exists."],
    ["42501", "Reviewer is not an active member of workspace ws-1"],
  ])("surfaces the RPC guard failure %s '%s' without a state change", async (code, message) => {
    const { admin, rpc } = buildRejectionMock({
      rpcResult: { data: null, error: { code, message } },
    });

    const result = await handleRejection({
      admin,
      expectedWorkspaceId: "ws-1",
      feedbackText: "needs work",
      requestedByMemberId: "mem-reviewer",
      sessionId: "sess-1",
      version: 1,
    });

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ error: message, success: false });
  });

  it("treats an empty RPC result as a lost race", async () => {
    const { admin } = buildRejectionMock({ rpcResult: { data: [], error: null } });

    const result = await handleRejection({
      admin,
      expectedWorkspaceId: "ws-1",
      feedbackText: "needs work",
      requestedByMemberId: "mem-reviewer",
      sessionId: "sess-1",
      version: 1,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("raced with another update");
  });

  it("fails before calling the RPC when the queued-run config cannot be resolved", async () => {
    mocked.loadWorkspaceAgentConfig.mockRejectedValueOnce(
      new Error('Unknown agent provider: "nope". Supported: codex, claude-code'),
    );
    const { admin, rpc } = buildRejectionMock();

    const result = await handleRejection({
      admin,
      expectedWorkspaceId: "ws-1",
      feedbackText: "needs work",
      requestedByMemberId: "mem-reviewer",
      sessionId: "sess-1",
      version: 1,
    });

    expect(rpc).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.error).toContain("Unknown agent provider");
  });
});
