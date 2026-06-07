import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, Tables } from "@/lib/supabase/database.types";
import type { AgentEvent, AgentRunner } from "@/lib/agent-runner/types";
import { normalizeAgentProviderName, type AgentProvider } from "@/lib/agent-config/contracts";
import { CodexAuthLeaseBusyError } from "@/lib/codex/contracts";

// ---- hoisted mocks ------------------------------------------------------
const mocked = vi.hoisted(() => ({
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
  octokitRequest: vi.fn().mockResolvedValue({ data: { token: "gh-token" } }),
  loadStageById: vi.fn(),
  loadCompletedStageArtifacts: vi.fn().mockResolvedValue({}),
  loadPipelineOperatingRules: vi.fn().mockResolvedValue(""),
  loadWorkspaceAgentConfig: vi.fn(),
  loadRequiredVercelSandboxConnection: vi.fn(),
  resolveSandboxImplementation: vi.fn(() => "vercel"),
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

vi.mock("@/lib/agent-runner", () => ({
  createAgentRunner: mocked.createAgentRunner,
  DEFAULT_AGENT_RUNNER_CONFIG: {
    provider: "codex",
    model: "gpt-5.5",
    maxTurns: 5,
  },
  loadWorkspaceAgentConfig: mocked.loadWorkspaceAgentConfig,
}));

vi.mock("@/lib/sandbox", () => ({
  createSessionSandbox: mocked.createSessionSandbox,
  resolveSandboxImplementation: mocked.resolveSandboxImplementation,
}));

vi.mock("@/lib/vercel-sandbox/server", () => ({
  loadRequiredVercelSandboxConnection: mocked.loadRequiredVercelSandboxConnection,
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
    job_type: "session",
    status: "queued",
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
    attempt_count: 0,
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
    phase_status: "agent_generating",
    rejection_count: 0,
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
  artifactInsertError?: { message: string } | null;
  messageInsertError?: { message: string } | null;
  messageInsertErrorOnMessage?: string;
  pointerUpdateError?: { message: string } | null;
  feedbackInsertError?: { message: string } | null;
  latestFeedback?: { feedback_text: string } | null;
  runSandboxUpdateError?: { message: string } | null;
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
  const insertedRuns: Array<Record<string, unknown>> = [];
  const insertedMessages: Array<Record<string, unknown>> = [];
  const updatedJobs: Array<Record<string, unknown>> = [];
  const updatedRuns: Array<Record<string, unknown>> = [];
  const updatedSessions: Array<Record<string, unknown>> = [];

  const lookup: Record<string, unknown> = {};
  for (const row of opts.agentConfig ?? []) {
    lookup[row.key] = row.value_json;
  }
  const rawProvider = typeof lookup.agent_provider === "string" ? lookup.agent_provider : undefined;
  const rawModel = typeof lookup.agent_model === "string" ? lookup.agent_model : undefined;
  const resolvedProvider = rawProvider ? normalizeAgentProviderName(rawProvider) : "codex";
  const resolvedConfig = {
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
    update: (patch: Record<string, unknown>) => ({
      eq: () => {
        updatedSessions.push(patch);
        return {
          in: () => ({
            select: () => ({
              maybeSingle: async () => ({
                data: opts.claimSucceeds === false ? null : { id: opts.session?.id },
                error: null,
              }),
            }),
          }),
          eq: () => ({
            eq: () => ({
              eq: () => ({
                select: () => ({
                  maybeSingle: async () => ({ data: { id: opts.session?.id }, error: null }),
                }),
              }),
            }),
          }),
        };
      },
    }),
  } as const;

  const artifactsTable = {
    insert: async (row: Record<string, unknown>) => {
      insertedArtifacts.push(row);
      return { error: opts.artifactInsertError ?? null };
    },
    delete: () => ({
      eq: () => ({
        eq: () => ({
          eq: async () => ({ error: null }),
        }),
      }),
    }),
  } as const;

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
    insert: (row: Record<string, unknown>) => {
      insertedRuns.push(row);
      return {
        select: () => ({ single: async () => ({ data: { id: "run-1" }, error: null }) }),
      };
    },
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
      updatedRuns.push(patch);
      const chain = {
        eq: () => chain,
        in: () => chain,
        select: () => ({
          maybeSingle: async () => ({ data: { id: "run-1" }, error: null }),
        }),
        then: (resolve: (value: { error: { message: string } | null }) => void) => {
          resolve({
            error:
              "sandbox_id" in patch && opts.runSandboxUpdateError
                ? opts.runSandboxUpdateError
                : null,
          });
        },
      };
      return chain;
    },
  } as const;

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

  const agentJobsTable = {
    delete: () => ({
      eq: () => ({
        eq: async () => ({ error: null }),
      }),
    }),
    update: (patch: Record<string, unknown>) => {
      const chain = {
        eq: () => chain,
        neq: () => chain,
        then: (resolve: (value: { error: { message: string } | null }) => void) => {
          updatedJobs.push(patch);
          resolve({ error: null });
        },
      };
      return chain;
    },
    insert: () => ({
      select: () => ({ single: async () => ({ data: { id: "job-enqueued" }, error: null }) }),
    }),
    select: () => ({
      eq: () => ({
        eq: () => ({
          in: () => ({
            order: () => ({
              limit: () => ({
                maybeSingle: async () => ({ data: { id: "job-enqueued" }, error: null }),
              }),
            }),
          }),
        }),
      }),
    }),
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
    session_artifacts: artifactsTable,
    session_artifact_feedback: feedbackTable,
    workspace_agent_config: agentConfigTable,
    agent_runs: agentRunsTable,
    agent_run_messages: agentRunMessagesTable,
    agent_jobs: agentJobsTable,
    workspace_members: workspaceMembersTable,
    github_installations: githubInstallationsTable,
    github_repositories: githubRepositoriesTable,
    session_pull_requests: sessionPullRequestsTable,
    workspace_onboarding: workspaceOnboardingTable,
    workspace_repository_profiles: workspaceRepositoryProfilesTable,
  };

  const rpc = vi.fn().mockResolvedValue({ data: null, error: null });

  return {
    admin: createProcessorTestAdminClient({
      from: (name: string) => tables[name] ?? {},
      rpc,
    }),
    insertedArtifacts,
    insertedMessages,
    insertedRuns,
    insertedFeedback,
    updatedJobs,
    updatedRuns,
    updatedSessions,
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
    async *start() {
      for (const event of events) yield event;
    },
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
    mocked.loadRequiredVercelSandboxConnection.mockResolvedValue({
      credentials: { projectId: "prj_123", teamId: "team_123", token: "vca_secret" },
      preview: { workspaceId: "ws-1" },
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
    const { admin, insertedArtifacts, insertedMessages, updatedSessions } = buildAdminMock({
      session,
      agentConfig: [],
    });

    const result = await processPipelineJob({ admin, job });

    expect(mocked.renderStagePrompt).toHaveBeenCalledTimes(1);
    expect(mocked.createSessionSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        vercelCredentials: { projectId: "prj_123", teamId: "team_123", token: "vca_secret" },
      }),
    );
    expect(insertedArtifacts).toHaveLength(1);
    const artifact = insertedArtifacts[0]!;
    expect(artifact.stage_slug).toBe("product");
    expect(artifact.version).toBe(1);
    expect(artifact.artifact_json).toContain("Drafted spec body");
    expect(artifact.artifact_json).not.toContain("Done");
    expect(insertedMessages).toEqual([
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
      { phase_status: "agent_generating" },
      { current_artifact_version: 1, phase_status: "awaiting_review" },
    ]);
    expect(result.result).toBe("success");
  });

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
    expect(insertedMessages).toEqual([
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
      { phase_status: "agent_generating" },
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
      model_name: "gpt-5.5",
      model_provider: "claude-code",
      stage_id: "stage-product",
      stage_name: "Product",
      stage_slug: "product",
      status: "running",
    });
    expect(updatedRuns.at(-1)).toMatchObject({ status: "success" });
  });

  it("marks the queued run errored when runner resolution fails before the run starts", async () => {
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
    expect(insertedMessages).toEqual([
      expect.objectContaining({
        kind: "error",
        message_md: "**Error:** Unsupported state or unable to authenticate data",
      }),
    ]);
    expect(updatedRuns).toEqual([
      expect.objectContaining({
        finished_at: expect.any(String),
        status: "error",
      }),
      expect.objectContaining({
        finished_at: expect.any(String),
        status: "error",
      }),
    ]);
    expect(updatedJobs.at(-1)).toMatchObject({
      last_error: "Unsupported state or unable to authenticate data",
      status: "error",
    });
    expect(updatedSessions).toEqual([
      { phase_status: "agent_generating" },
      { phase_status: "rejected" },
    ]);
  });

  it("refreshes run activity when runner events are persisted", async () => {
    mocked.createAgentRunner.mockReturnValue(makeRunner([{ type: "text", text: "Spec body" }]));
    const session = baseSession();
    const { admin, updatedRuns } = buildAdminMock({
      session,
      agentConfig: [],
    });

    await processPipelineJob({ admin, job: baseJob() });

    const activityUpdates = updatedRuns.filter((patch) => "last_activity_at" in patch);
    expect(activityUpdates).toHaveLength(2);
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
      { phase_status: "agent_generating" },
      { phase_status: "rejected" },
    ]);
  });

  it("resolves the session owner's Anthropic API key for Claude Code runs", async () => {
    const session = baseSession();
    const { admin } = buildAdminMock({
      session,
      agentConfig: [
        { key: "agent_provider", value_json: "claude-code" },
        { key: "agent_model", value_json: "claude-sonnet-4-5" },
      ],
    });

    await processPipelineJob({ admin, job: baseJob() });

    expect(mocked.getClaudeCodeCredentialForSession).toHaveBeenCalledWith(admin, session);
    expect(mocked.createAgentRunner).toHaveBeenCalledWith("claude-code", {
      claudeCode: {
        credential: { secret: "sk-ant-test" },
        model: "claude-sonnet-4-5",
      },
    });
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
    expect((call.branch as string).endsWith(session.id)).toBe(true);
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
      { phase_status: "agent_generating" },
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
    expect(insertedMessages).toEqual([
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
      { phase_status: "agent_generating" },
      { phase_status: "rejected" },
    ]);
  });

  it("rolls back the artifact pointer when the stage completion message fails", async () => {
    const session = baseSession({ current_artifact_version: 2 });
    const {
      admin,
      insertedArtifacts,
      insertedMessages,
      updatedJobs,
      updatedRuns,
      updatedSessions,
    } = buildAdminMock({
      session,
      messageInsertError: { message: "completion insert failed" },
      messageInsertErrorOnMessage: "Product run completed",
    });

    const result = await processPipelineJob({ admin, job: baseJob({ attempt_count: 3 }) });

    expect(result.result).toBe("error");
    expect(insertedArtifacts).toHaveLength(1);
    expect(insertedArtifacts[0]).toMatchObject({
      version: 3,
    });
    expect(insertedMessages).toEqual([
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
        message_md: "**Error:** completion insert failed",
      }),
    ]);
    expect(updatedRuns.at(-1)).toMatchObject({ status: "error" });
    expect(updatedJobs.at(-1)).toMatchObject({
      last_error: "completion insert failed",
      status: "error",
    });
    expect(updatedSessions).toEqual([
      { phase_status: "agent_generating" },
      { current_artifact_version: 3, phase_status: "awaiting_review" },
      { current_artifact_version: 2, phase_status: "rejected" },
    ]);
  });

  it("returns success without running the agent when the CAS claim fails (terminal state)", async () => {
    const session = baseSession({ phase_status: "approved" });
    const { admin } = buildAdminMock({
      session,
      claimSucceeds: false,
    });
    const result = await processPipelineJob({ admin, job: baseJob() });
    expect(mocked.renderStagePrompt).not.toHaveBeenCalled();
    expect(result.result).toBe("success");
  });

  it("errors when a sandbox-required runner has no GitHub installation for the workspace", async () => {
    const session = baseSession();
    const { admin, insertedMessages, updatedSessions } = buildAdminMock({
      session,
      githubInstallation: null,
    });
    const result = await processPipelineJob({ admin, job: baseJob() });
    expect(result.result).toBe("error");
    expect(insertedMessages).toEqual([
      expect.objectContaining({
        kind: "error",
        message_md:
          "**Error:** No GitHub installation or repository found for workspace. Connect a GitHub repository in workspace settings.",
      }),
    ]);
    expect(mocked.createSessionSandbox).not.toHaveBeenCalled();
    expect(mocked.openSessionPullRequest).not.toHaveBeenCalled();
    expect(mocked.renderStagePrompt).toHaveBeenCalledTimes(1);
    expect(updatedSessions).toEqual([
      { phase_status: "agent_generating" },
      { phase_status: "rejected" },
    ]);
  });

  it("aborts before sandbox creation when Vercel Sandbox is not connected", async () => {
    const error = new Error("Connect a Vercel Sandbox account before starting Wallie runs.");
    error.name = "VercelSandboxConnectionMissingError";
    mocked.loadRequiredVercelSandboxConnection.mockRejectedValueOnce(error);
    const session = baseSession();
    const { admin, insertedArtifacts, insertedMessages, rpc, updatedJobs, updatedSessions } =
      buildAdminMock({
        session,
      });

    const result = await processPipelineJob({ admin, job: baseJob() });

    expect(result.result).toBe("error");
    expect(insertedArtifacts).toHaveLength(0);
    expect(insertedMessages).toEqual([
      expect.objectContaining({
        kind: "error",
        message_md: "**Error:** Connect a Vercel Sandbox account before starting Wallie runs.",
      }),
    ]);
    expect(mocked.createSessionSandbox).not.toHaveBeenCalled();
    expect(updatedSessions).toEqual([
      { phase_status: "agent_generating" },
      { phase_status: "rejected" },
    ]);
    expect(rpc).not.toHaveBeenCalledWith("schedule_job_retry", expect.anything());
    expect(updatedJobs.at(-1)).toMatchObject({
      last_error: "Connect a Vercel Sandbox account before starting Wallie runs.",
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
    expect(mocked.loadRequiredVercelSandboxConnection).not.toHaveBeenCalled();
    expect(mocked.createSessionSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        implementation: "fake",
        vercelCredentials: undefined,
      }),
    );
    expect(updatedRuns).toContainEqual({
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
    expect(insertedMessages).toEqual([
      expect.objectContaining({
        kind: "error",
        message_md:
          "**Error:** vercel sandbox unavailable: https://[redacted]@example.com/run?token=[redacted]",
      }),
    ]);
    expect(mocked.openSessionPullRequest).not.toHaveBeenCalled();
    expect(updatedSessions).toEqual([
      { phase_status: "agent_generating" },
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
    expect(insertedMessages).toEqual([
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
    expect(insertedMessages[0]!.message_md).not.toContain("BEGIN PRIVATE KEY");
    expect(insertedMessages[0]!.message_md).not.toContain("abc def ghi");
    expect(insertedMessages[0]!.message_md).not.toContain("first second third");
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
    expect(insertedMessages).toEqual([
      expect.objectContaining({
        kind: "error",
        message_md: [
          "**Error:** sandbox failed while loading env",
          'API_KEY="[redacted]"',
          "Retry after reconnecting.",
        ].join("\n"),
      }),
    ]);
    expect(insertedMessages[0]!.message_md).not.toContain("abc");
    expect(insertedMessages[0]!.message_md).not.toContain("def-secret");
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
    expect(insertedMessages).toEqual([
      expect.objectContaining({
        kind: "error",
        message_md:
          '**Error:** sandbox config rejected: {"token": "[redacted]","password": "[redacted]","safe":"visible"}',
      }),
    ]);
    expect(insertedMessages[0]!.message_md).not.toContain("plain-secret-12345");
    expect(insertedMessages[0]!.message_md).not.toContain("hunter2");
    expect(insertedMessages[0]!.message_md).toContain('"safe":"visible"');
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
    expect(insertedMessages).toEqual([
      expect.objectContaining({
        kind: "error",
        message_md:
          '**Error:** sandbox config rejected: {"apiKey": "[redacted]","privateKey": "[redacted]","clientSecret": "[redacted]","safe":"visible"}',
      }),
    ]);
    expect(insertedMessages[0]!.message_md).not.toContain("plain-api-key");
    expect(insertedMessages[0]!.message_md).not.toContain("plain-private-key");
    expect(insertedMessages[0]!.message_md).not.toContain("plain-client-secret");
    expect(insertedMessages[0]!.message_md).toContain('"safe":"visible"');
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
    expect(insertedMessages).toEqual([
      expect.objectContaining({
        kind: "error",
        message_md:
          '**Error:** sandbox config rejected: {"token": "[redacted]","privateKey": "[redacted]","safe":"visible"}',
      }),
    ]);
    expect(insertedMessages[0]!.message_md).not.toContain("plain-secret-12345");
    expect(insertedMessages[0]!.message_md).not.toContain("line1");
    expect(insertedMessages[0]!.message_md).not.toContain("line2");
    expect(insertedMessages[0]!.message_md).toContain('"safe":"visible"');
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
    expect(insertedMessages).toEqual([
      expect.objectContaining({
        kind: "error",
        message_md: "**Error:** sandbox id write failed",
      }),
    ]);
    expect(mocked.openSessionPullRequest).not.toHaveBeenCalled();
    expect(updatedRuns[1]).toEqual({
      sandbox_id: "sandbox-1",
      sandbox_provider: "vercel",
      sandbox_vercel_project_id: "prj_123",
      sandbox_vercel_team_id: "team_123",
    });
    expect(updatedRuns.at(-1)).toMatchObject({ status: "error" });
    expect(updatedSessions).toEqual([
      { phase_status: "agent_generating" },
      { phase_status: "rejected" },
    ]);
  });

  it("records a visible error and defers when Codex ChatGPT auth lease is busy", async () => {
    mocked.createAgentRunner.mockReturnValue({
      provider: "codex",
      requiresSandbox: true,
      async *start() {
        throw new CodexAuthLeaseBusyError();
      },
    });
    const session = baseSession();
    const { admin, insertedMessages, rpc, updatedJobs, updatedRuns, updatedSessions } =
      buildAdminMock({ session });

    const result = await processPipelineJob({ admin, job: baseJob() });

    expect(result).toEqual({
      jobId: "job-1",
      processed: true,
      result: "idle",
      runId: "run-1",
    });
    expect(insertedMessages).toEqual([
      expect.objectContaining({
        kind: "error",
        message_md: "**Error:** Codex ChatGPT auth is already in use by another run.",
      }),
    ]);
    expect(updatedRuns.at(-1)).toMatchObject({ status: "error" });
    expect(updatedSessions.at(-1)).toEqual({ phase_status: "agent_generating" });
    expect(rpc).toHaveBeenCalledWith("schedule_job_retry", {
      base_delay_ms: 15000,
      max_backoff_ms: 120000,
      target_job_id: "job-1",
    });
    expect(updatedJobs.at(-1)).toEqual({
      last_error: "Codex ChatGPT auth is already in use by another run.",
    });
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
      { phase_status: "agent_generating" },
      { phase_status: "rejected" },
    ]);
    consoleError.mockRestore();
  });

  it("treats an agent error event as a stage failure and deletes the orphan artifact", async () => {
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
    expect(insertedMessages).toEqual([
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
      { phase_status: "agent_generating" },
      { phase_status: "rejected" },
    ]);
  });
});

// ---- handleApproval -----------------------------------------------------

describe("handleApproval", () => {
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

  it("keeps approval successful when automatic enqueue fails after the stage RPC commits", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const rpc = vi.fn().mockResolvedValue({
      data: [{ id: "sess-1", archived_at: null, phase_status: "agent_generating" }],
      error: null,
    });
    const enqueueError = {
      code: "deadlock",
      message: "queue write failed",
    };
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

    expect(result).toEqual({ jobId: null, success: true });
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
  session: Tables<"sessions"> | null;
  rejectionClaim?: { id: string } | null;
  rejectionClaimError?: { message: string } | null;
  enqueueError?: { code?: string; message: string } | null;
  workspaceMember?: { id: string } | null;
  feedbackInsertError?: { message: string; code?: string } | null;
}

function buildRejectionMock(opts: RejectionMockOptions) {
  const sessionUpdates: Array<Record<string, unknown>> = [];
  const artifactUpdates: Array<{ patch: Record<string, unknown> }> = [];
  const insertedFeedback: Array<Record<string, unknown>> = [];
  const enqueuedJobs: Array<Record<string, unknown>> = [];

  const sessionsTable = {
    select: () => {
      const builder = {
        eq: () => builder,
        maybeSingle: async () => ({ data: opts.session, error: null }),
      };
      return builder;
    },
    update: (patch: Record<string, unknown>) => {
      sessionUpdates.push(patch);
      const eqChain = {
        eq() {
          return eqChain;
        },
        select() {
          return {
            maybeSingle: async () => ({
              data: opts.rejectionClaim === undefined ? { id: "sess-1" } : opts.rejectionClaim,
              error: opts.rejectionClaimError ?? null,
            }),
          };
        },
        then(resolve: (value: { data: null; error: null }) => void) {
          resolve({ data: null, error: null });
        },
      };
      const builder: Record<string, unknown> = {};
      builder.eq = () => eqChain;
      return builder;
    },
  };

  const artifactsTable = {
    update: (patch: Record<string, unknown>) => ({
      eq: () => ({
        eq: () => ({
          eq: async () => {
            artifactUpdates.push({ patch });
            return { error: null };
          },
        }),
      }),
    }),
  };

  const workspaceMembersTable = {
    select: () => ({
      eq: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: opts.workspaceMember ?? null, error: null }),
          }),
        }),
      }),
    }),
  };

  const agentJobsTable = {
    delete: () => ({
      eq: () => ({
        eq: async () => ({ error: null }),
      }),
    }),
    insert: (row: Record<string, unknown>) => {
      enqueuedJobs.push(row);
      return {
        select: () => ({
          single: async () => ({
            data: opts.enqueueError ? null : { id: "job-retry" },
            error: opts.enqueueError ?? null,
          }),
        }),
      };
    },
    select: () => ({
      eq: () => ({
        eq: () => ({
          in: () => ({
            order: () => ({
              limit: () => ({
                maybeSingle: async () => ({ data: { id: "job-retry-existing" }, error: null }),
              }),
            }),
          }),
        }),
      }),
    }),
  };

  const agentRunsTable = {
    insert: async () => ({ error: null }),
  };

  const agentConfigTable = {
    select: () => ({
      eq: () => ({
        in: async () => ({ data: [], error: null }),
      }),
    }),
  };

  const feedbackTable = {
    insert: async (row: Record<string, unknown>) => {
      insertedFeedback.push(row);
      return { error: opts.feedbackInsertError ?? null };
    },
  };

  const sessionPullRequestsTable = {
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

  const tables: Record<string, unknown> = {
    sessions: sessionsTable,
    session_artifacts: artifactsTable,
    session_artifact_feedback: feedbackTable,
    workspace_members: workspaceMembersTable,
    agent_jobs: agentJobsTable,
    agent_runs: agentRunsTable,
    workspace_agent_config: agentConfigTable,
    session_pull_requests: sessionPullRequestsTable,
    workspace_repository_profiles: workspaceRepositoryProfilesTable,
    workspace_onboarding: workspaceOnboardingTable,
  };

  return {
    admin: createProcessorTestAdminClient({ from: (name: string) => tables[name] ?? {} }),
    sessionUpdates,
    artifactUpdates,
    insertedFeedback,
    enqueuedJobs,
  };
}

describe("handleRejection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked.loadStageById.mockResolvedValue(productStage);
  });

  it("returns 'session not found' when the session row is missing", async () => {
    const { admin } = buildRejectionMock({ session: null });
    const result = await handleRejection({
      admin,
      expectedWorkspaceId: "ws-1",
      feedbackText: "needs work",
      requestedByMemberId: "mem-reviewer",
      sessionId: "sess-1",
      version: 1,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Session not found");
  });

  it("returns 'session not found' when the workspace doesn't match (cross-workspace guard)", async () => {
    const session = baseSession({ workspace_id: "ws-OTHER", phase_status: "awaiting_review" });
    const { admin } = buildRejectionMock({ session });
    const result = await handleRejection({
      admin,
      expectedWorkspaceId: "ws-1",
      feedbackText: "needs work",
      requestedByMemberId: "mem-reviewer",
      sessionId: "sess-1",
      version: 1,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Session not found");
  });

  it("rejects with a version-mismatch error when current_artifact_version moved on", async () => {
    const session = baseSession({
      phase_status: "awaiting_review",
      current_artifact_version: 2,
    });
    const { admin } = buildRejectionMock({ session });
    const result = await handleRejection({
      admin,
      expectedWorkspaceId: "ws-1",
      feedbackText: "needs work",
      requestedByMemberId: "mem-reviewer",
      sessionId: "sess-1",
      version: 1,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Version mismatch");
  });

  it("rejects with 'race' when the rejection_count CAS finds no matching row", async () => {
    const session = baseSession({
      phase_status: "awaiting_review",
      current_artifact_version: 1,
    });
    const { admin } = buildRejectionMock({ session, rejectionClaim: null });
    const result = await handleRejection({
      admin,
      expectedWorkspaceId: "ws-1",
      feedbackText: "needs work",
      requestedByMemberId: "mem-reviewer",
      sessionId: "sess-1",
      version: 1,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("raced");
  });

  it("writes feedback, enqueues a retry, then flips status to rejected", async () => {
    const session = baseSession({
      phase_status: "awaiting_review",
      current_artifact_version: 1,
      rejection_count: 0,
    });
    const { admin, sessionUpdates, insertedFeedback, enqueuedJobs } = buildRejectionMock({
      session,
    });

    const result = await handleRejection({
      admin,
      expectedWorkspaceId: "ws-1",
      feedbackText: "tighten the spec",
      requestedByMemberId: "mem-reviewer",
      sessionId: "sess-1",
      version: 1,
    });

    expect(result.success).toBe(true);
    expect(result.jobId).toBe("job-retry");
    expect(insertedFeedback).toHaveLength(1);
    expect(insertedFeedback[0]).toMatchObject({
      feedback_text: "tighten the spec",
      session_id: "sess-1",
      target_version: 1,
    });
    expect(enqueuedJobs).toHaveLength(1);
    expect(enqueuedJobs[0]!.session_id).toBe("sess-1");
    expect(enqueuedJobs[0]!.requested_by_member_id).toBe("mem-reviewer");
    expect(enqueuedJobs[0]).toMatchObject({
      stage_id: "stage-product",
      stage_name: "Product",
      stage_slug: "product",
    });
    expect(enqueuedJobs[0]!.trigger_type).toBe("comment_retry");
    expect(sessionUpdates[0]).toEqual({ rejection_count: 1 });
    expect(sessionUpdates.at(-1)).toEqual({ phase_status: "rejected" });
  });

  it("treats a unique_violation on enqueue (23505) as silent success — the existing queued job will pick up the feedback", async () => {
    const session = baseSession({
      phase_status: "awaiting_review",
      current_artifact_version: 1,
      rejection_count: 0,
    });
    const { admin, sessionUpdates } = buildRejectionMock({
      session,
      enqueueError: { code: "23505", message: "duplicate" },
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
    expect(sessionUpdates.at(-1)).toEqual({ phase_status: "rejected" });
  });

  it("returns the enqueue error and stops *before* flipping to rejected when the retry can't be queued", async () => {
    const session = baseSession({
      phase_status: "awaiting_review",
      current_artifact_version: 1,
      rejection_count: 0,
    });
    const { admin, sessionUpdates } = buildRejectionMock({
      session,
      enqueueError: { code: "deadlock", message: "queue write failed" },
    });
    const result = await handleRejection({
      admin,
      expectedWorkspaceId: "ws-1",
      feedbackText: "boom",
      requestedByMemberId: "mem-reviewer",
      sessionId: "sess-1",
      version: 1,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("queue write failed");
    expect(sessionUpdates).toEqual([{ rejection_count: 1 }]);
  });

  it("treats a 23505 feedback insert as idempotent so a retry after a prior enqueue failure can still flip phase_status", async () => {
    const session = baseSession({
      phase_status: "awaiting_review",
      current_artifact_version: 1,
      rejection_count: 0,
    });
    const { admin, sessionUpdates } = buildRejectionMock({
      session,
      feedbackInsertError: {
        code: "23505",
        message: "duplicate key value violates unique constraint",
      },
    });

    const result = await handleRejection({
      admin,
      expectedWorkspaceId: session.workspace_id,
      feedbackText: "race",
      requestedByMemberId: "mem-reviewer",
      sessionId: session.id,
      version: 1,
    });

    expect(result.success).toBe(true);
    expect(sessionUpdates).toEqual([{ rejection_count: 1 }, { phase_status: "rejected" }]);
  });

  it("aborts the rejection when the feedback insert fails with a non-23505 error", async () => {
    const session = baseSession({
      phase_status: "awaiting_review",
      current_artifact_version: 1,
      rejection_count: 0,
    });
    const { admin, sessionUpdates } = buildRejectionMock({
      session,
      feedbackInsertError: { code: "23503", message: "foreign key violation" },
    });

    const result = await handleRejection({
      admin,
      expectedWorkspaceId: session.workspace_id,
      feedbackText: "boom",
      requestedByMemberId: "mem-reviewer",
      sessionId: session.id,
      version: 1,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("foreign key");
    expect(sessionUpdates).toEqual([{ rejection_count: 1 }]);
  });
});
