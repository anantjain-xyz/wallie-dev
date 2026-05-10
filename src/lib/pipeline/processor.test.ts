import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, Tables } from "@/lib/supabase/database.types";
import type { AgentEvent, AgentRunner } from "@/lib/agent-runner/types";

// ---- hoisted mocks ------------------------------------------------------
const mocked = vi.hoisted(() => ({
  createSupabaseAdminClient: vi.fn(),
  decryptSecretValue: vi.fn((v: string) => v),
  postSlackMessage: vi.fn().mockResolvedValue({ ts: "1234567890.123456" }),
  openSlackDm: vi.fn().mockResolvedValue("D-dm-channel"),
  formatStageReviewBlocks: vi.fn(() => [{ type: "section" }]),
  formatGenerationFailureBlocks: vi.fn(() => [{ type: "section" }]),
  formatEscalationDmBlocks: vi.fn(() => [{ type: "section" }]),
  escapeMrkdwn: vi.fn((s: string) => s),
  createAgentRunner: vi.fn(),
  createSessionSandbox: vi.fn().mockResolvedValue({
    id: "sandbox-1",
    repoPath: "/vercel/sandbox",
    exec: vi.fn(),
    readFile: vi.fn(),
    stop: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn(),
  }),
  getCodexAccessTokenForSession: vi.fn().mockResolvedValue("codex-token"),
  octokitRequest: vi.fn().mockResolvedValue({ data: { token: "gh-token" } }),
  loadStageById: vi.fn(),
  loadPipelineWithStages: vi.fn(),
  loadCompletedStageArtifacts: vi.fn().mockResolvedValue({}),
  loadWorkspaceAgentConfig: vi.fn(),
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

vi.mock("@/lib/secrets/crypto", () => ({
  decryptSecretValue: mocked.decryptSecretValue,
}));

vi.mock("./slack-format", () => ({
  escapeMrkdwn: mocked.escapeMrkdwn,
  formatEscalationDmBlocks: mocked.formatEscalationDmBlocks,
  formatGenerationFailureBlocks: mocked.formatGenerationFailureBlocks,
  formatStageReviewBlocks: mocked.formatStageReviewBlocks,
  openSlackDm: mocked.openSlackDm,
  postSlackMessage: mocked.postSlackMessage,
}));

vi.mock("./stages", () => ({
  loadStageById: mocked.loadStageById,
  loadPipelineWithStages: mocked.loadPipelineWithStages,
  loadCompletedStageArtifacts: mocked.loadCompletedStageArtifacts,
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
    model: "gpt-5-codex",
    maxTurns: 5,
  },
  loadWorkspaceAgentConfig: mocked.loadWorkspaceAgentConfig,
}));

vi.mock("@/lib/sandbox", () => ({
  createSessionSandbox: mocked.createSessionSandbox,
}));

vi.mock("@/lib/codex/tokens", () => ({
  CodexNotConnectedError: class CodexNotConnectedError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "CodexNotConnectedError";
    }
  },
  getCodexAccessTokenForSession: mocked.getCodexAccessTokenForSession,
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
    trigger_type: "slack_mention",
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
    linear_issue_id: "TEAM-1",
    linear_issue_url: "https://linear.app/team/issue/TEAM-1",
    slack_channel_id: "C-test",
    slack_thread_ts: "1234567890.123456",
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

const designStage = {
  approverMemberIds: [],
  description: "Resolve design",
  id: "stage-design",
  name: "Design",
  pipelineId: "pipe-1",
  position: 2,
  promptTemplateMd: "design",
  slug: "design",
};

// ---- supabase mock builder ---------------------------------------------

interface MockOptions {
  session: Tables<"sessions"> | null;
  slackInstall?: { bot_token_encrypted: string } | null;
  agentConfig?: Array<{ key: string; value_json: unknown }>;
  claimSucceeds?: boolean;
  artifactInsertError?: { message: string } | null;
  pointerUpdateError?: { message: string } | null;
  feedbackInsertError?: { message: string } | null;
  /** Latest-feedback row returned to `loadLatestFeedback`. */
  latestFeedback?: { feedback_text: string } | null;
  /** Map of `key` → encrypted_value returned from `workspace_secrets`. */
  workspaceSecrets?: Record<string, string>;
  /** When set, github_installations.maybeSingle returns this row. Default: a row exists. */
  githubInstallation?: { id: string; installation_id: number } | null;
}

type AdminClient = SupabaseClient<Database>;
type TestAdminClient = Pick<AdminClient, "from" | "rpc">;

/**
 * Keep processor admin mocks structurally tied to the Supabase admin surface
 * the code under test uses. `createTestAdminClient` returns the typed
 * Pick<AdminClient, "from" | "rpc"> surface for future mocks; the adapter
 * below centralizes the cast needed by production function signatures so test
 * bodies do not hide incomplete mocks behind opaque per-call casts.
 */
function createTestAdminClient(input: {
  from: (name: string) => unknown;
  rpc?: (fn: string, args?: unknown) => unknown;
}): TestAdminClient {
  return {
    from: input.from as AdminClient["from"],
    rpc: (input.rpc ??
      vi.fn().mockResolvedValue({ data: null, error: null })) as AdminClient["rpc"],
  };
}

function createProcessorTestAdminClient(
  input: Parameters<typeof createTestAdminClient>[0],
): AdminClient {
  return createTestAdminClient(input) as AdminClient;
}

function buildAdminMock(opts: MockOptions) {
  const insertedArtifacts: Array<Record<string, unknown>> = [];
  const updatedSessions: Array<Record<string, unknown>> = [];

  // Mirror the resolution logic in `loadWorkspaceAgentConfig` so tests can
  // continue to drive behavior via the existing `agentConfig` option.
  const lookup: Record<string, unknown> = {};
  for (const row of opts.agentConfig ?? []) {
    lookup[row.key] = row.value_json;
  }
  const rawProvider = typeof lookup.agent_provider === "string" ? lookup.agent_provider : undefined;
  const rawModel = typeof lookup.agent_model === "string" ? lookup.agent_model : undefined;
  const resolvedConfig = {
    maxTurns: typeof lookup.max_turns === "number" ? lookup.max_turns : undefined,
    model: rawModel ?? "gpt-5-codex",
    provider: (rawProvider ?? "codex").replace(/_/g, "-"),
  };
  mocked.loadWorkspaceAgentConfig.mockResolvedValue(resolvedConfig);

  const sessionsTable = {
    select: () => ({
      eq: () => ({
        maybeSingle: async () => ({ data: opts.session, error: null }),
      }),
    }),
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

  const slackTable = {
    select: () => ({
      eq: () => ({ maybeSingle: async () => ({ data: opts.slackInstall ?? null, error: null }) }),
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
    insert: () => ({
      select: () => ({ single: async () => ({ data: { id: "run-1" }, error: null }) }),
    }),
    update: () => ({ eq: async () => ({ error: null }) }),
  } as const;

  const agentRunMessagesTable = {
    insert: async () => ({ error: null }),
  } as const;

  const agentJobsTable = {
    update: () => ({ eq: async () => ({ error: null }) }),
    insert: async () => ({ error: null }),
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

  const workspaceSecretsTable = {
    select: () => ({
      eq: () => ({
        eq: (_col: string, key: string) => ({
          maybeSingle: async () => ({
            data: opts.workspaceSecrets?.[key]
              ? { encrypted_value: opts.workspaceSecrets[key] }
              : null,
            error: null,
          }),
        }),
      }),
    }),
  } as const;

  const githubInstallation =
    opts.githubInstallation === undefined
      ? { id: "ghi-1", installation_id: 123 }
      : opts.githubInstallation;
  const githubInstallationsTable = {
    select: () => ({
      eq: () => ({
        maybeSingle: async () => ({ data: githubInstallation, error: null }),
      }),
    }),
  } as const;

  const githubRepositoriesTable = {
    select: () => ({
      eq: () => ({
        eq: () => ({
          order: () => ({
            limit: () => ({
              maybeSingle: async () => ({
                data: { default_branch: "main", full_name: "acme/app", id: "repo-1" },
                error: null,
              }),
            }),
          }),
        }),
      }),
    }),
  } as const;

  const tables: Record<string, unknown> = {
    sessions: sessionsTable,
    session_artifacts: artifactsTable,
    session_artifact_feedback: feedbackTable,
    slack_installations: slackTable,
    workspace_agent_config: agentConfigTable,
    agent_runs: agentRunsTable,
    agent_run_messages: agentRunMessagesTable,
    agent_jobs: agentJobsTable,
    workspace_members: workspaceMembersTable,
    workspace_secrets: workspaceSecretsTable,
    github_installations: githubInstallationsTable,
    github_repositories: githubRepositoriesTable,
  };

  return {
    admin: createProcessorTestAdminClient({
      from: (name: string) => tables[name] ?? {},
      rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
    }),
    insertedArtifacts,
    insertedFeedback,
    updatedSessions,
  };
}

// ---- agent-runner mock --------------------------------------------------

function makeRunner(
  events: AgentEvent[],
  opts: { provider?: string; requiresSandbox?: boolean } = {},
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
    mocked.loadStageById.mockResolvedValue(productStage);
    mocked.loadPipelineWithStages.mockResolvedValue({
      id: "pipe-1",
      isDefault: true,
      name: "Default",
      stages: [productStage, designStage],
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
    const { admin, insertedArtifacts, updatedSessions } = buildAdminMock({
      session,
      slackInstall: { bot_token_encrypted: "tok" },
      agentConfig: [],
    });

    const result = await processPipelineJob({ admin, job });

    expect(mocked.renderStagePrompt).toHaveBeenCalledTimes(1);
    expect(mocked.formatStageReviewBlocks).toHaveBeenCalledTimes(1);
    expect(mocked.postSlackMessage).toHaveBeenCalledTimes(1);
    expect(insertedArtifacts).toHaveLength(1);
    const artifact = insertedArtifacts[0]!;
    expect(artifact.stage_slug).toBe("product");
    expect(artifact.version).toBe(1);
    expect(artifact.artifact_json).toContain("Drafted spec body");
    expect(updatedSessions).toEqual([
      { phase_status: "agent_generating" },
      { current_artifact_version: 1, phase_status: "awaiting_review" },
    ]);
    expect(result.result).toBe("success");
  });

  it("opens a session pull request after the artifact is persisted", async () => {
    const session = baseSession();
    const job = baseJob();
    const { admin } = buildAdminMock({
      session,
      slackInstall: { bot_token_encrypted: "tok" },
    });

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

  it("does not abort the stage when opening the pull request fails", async () => {
    mocked.openSessionPullRequest.mockResolvedValueOnce({
      kind: "pr_failed",
      reason: "boom",
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const session = baseSession();
    const { admin, insertedArtifacts, updatedSessions } = buildAdminMock({
      session,
      slackInstall: { bot_token_encrypted: "tok" },
    });

    const result = await processPipelineJob({ admin, job: baseJob() });

    expect(insertedArtifacts).toHaveLength(1);
    expect(updatedSessions).toEqual([
      { phase_status: "agent_generating" },
      { current_artifact_version: 1, phase_status: "awaiting_review" },
    ]);
    expect(mocked.postSlackMessage).toHaveBeenCalledTimes(1);
    expect(result.result).toBe("success");
    consoleError.mockRestore();
  });

  it("returns success without running the agent when the CAS claim fails (terminal state)", async () => {
    const session = baseSession({ phase_status: "approved" });
    const { admin } = buildAdminMock({
      session,
      slackInstall: { bot_token_encrypted: "tok" },
      claimSucceeds: false,
    });
    const result = await processPipelineJob({ admin, job: baseJob() });
    expect(mocked.renderStagePrompt).not.toHaveBeenCalled();
    expect(result.result).toBe("success");
  });

  it("skips sandbox + GitHub provisioning when the runner is anthropic-api", async () => {
    const session = baseSession();
    const job = baseJob();
    const { admin, insertedArtifacts } = buildAdminMock({
      session,
      slackInstall: { bot_token_encrypted: "tok" },
      agentConfig: [{ key: "agent_provider", value_json: "anthropic_api" }],
      workspaceSecrets: { ANTHROPIC_API_KEY: "sk-ant-…" },
      // Even with no GitHub install, anthropic-api should still run.
      githubInstallation: null,
    });

    mocked.createAgentRunner.mockReturnValue(
      makeRunner(
        [
          { type: "text", text: "Hello from API" },
          { type: "completion", taskComplete: true, summary: "Done" },
        ],
        { provider: "anthropic-api", requiresSandbox: false },
      ),
    );

    const result = await processPipelineJob({ admin, job });

    expect(result.result).toBe("success");
    expect(mocked.createSessionSandbox).not.toHaveBeenCalled();
    expect(mocked.openSessionPullRequest).not.toHaveBeenCalled();
    expect(mocked.createAgentRunner).toHaveBeenCalledWith(
      "anthropic-api",
      expect.objectContaining({ anthropic: expect.objectContaining({ apiKey: "sk-ant-…" }) }),
    );
    expect(insertedArtifacts).toHaveLength(1);
    expect((insertedArtifacts[0] as { artifact_json: string }).artifact_json).toContain(
      "Hello from API",
    );
  });

  it("errors when anthropic-api is selected but ANTHROPIC_API_KEY is missing", async () => {
    const session = baseSession();
    const { admin } = buildAdminMock({
      session,
      slackInstall: { bot_token_encrypted: "tok" },
      agentConfig: [{ key: "agent_provider", value_json: "anthropic_api" }],
      workspaceSecrets: {},
    });
    const result = await processPipelineJob({ admin, job: baseJob() });
    expect(result.result).toBe("error");
    expect(mocked.createSessionSandbox).not.toHaveBeenCalled();
  });

  it("errors out cleanly when the workspace has no Slack installation", async () => {
    const session = baseSession();
    const { admin } = buildAdminMock({
      session,
      slackInstall: null,
    });
    const result = await processPipelineJob({ admin, job: baseJob() });
    expect(result.result).toBe("error");
    expect(mocked.renderStagePrompt).not.toHaveBeenCalled();
  });

  it("errors when a sandbox-required runner has no GitHub installation for the workspace", async () => {
    const session = baseSession();
    // Default runner is claude-code (requiresSandbox: true). With no github
    // install the processor must error out — without this branch the run would
    // try to mint a token for installation_id=undefined and crash later.
    const { admin } = buildAdminMock({
      session,
      slackInstall: { bot_token_encrypted: "tok" },
      githubInstallation: null,
    });
    const result = await processPipelineJob({ admin, job: baseJob() });
    expect(result.result).toBe("error");
    expect(mocked.createSessionSandbox).not.toHaveBeenCalled();
    expect(mocked.openSessionPullRequest).not.toHaveBeenCalled();
    expect(mocked.renderStagePrompt).toHaveBeenCalledTimes(1);
  });

  it("aborts the stage and flips status to rejected when sandbox provisioning fails", async () => {
    mocked.createSessionSandbox.mockRejectedValueOnce(new Error("vercel sandbox unavailable"));
    const session = baseSession();
    const { admin, insertedArtifacts, updatedSessions } = buildAdminMock({
      session,
      slackInstall: { bot_token_encrypted: "tok" },
    });

    const result = await processPipelineJob({ admin, job: baseJob() });

    expect(result.result).toBe("error");
    // Sandbox failed before run row got created, so no orphan artifact, no PR.
    expect(insertedArtifacts).toHaveLength(0);
    expect(mocked.openSessionPullRequest).not.toHaveBeenCalled();
    expect(updatedSessions).toEqual([
      { phase_status: "agent_generating" },
      { phase_status: "rejected" },
    ]);
    // Slack failure message posted (not the review one).
    expect(mocked.formatGenerationFailureBlocks).toHaveBeenCalledTimes(1);
    expect(mocked.formatStageReviewBlocks).not.toHaveBeenCalled();
  });

  it("treats an agent error event as a stage failure and deletes the orphan artifact", async () => {
    mocked.createAgentRunner.mockReturnValue(
      makeRunner([
        { type: "text", text: "partial output" },
        { type: "error", message: "rate limited" },
      ]),
    );
    const session = baseSession();
    const { admin, insertedArtifacts, updatedSessions } = buildAdminMock({
      session,
      slackInstall: { bot_token_encrypted: "tok" },
    });

    const result = await processPipelineJob({ admin, job: baseJob() });

    expect(result.result).toBe("error");
    // Error fires *before* artifact insert (the for-await throws when type === "error"),
    // so no orphan should exist. The artifact-insert branch is guarded by
    // `artifactInserted` and never runs.
    expect(insertedArtifacts).toHaveLength(0);
    // No PR opened.
    expect(mocked.openSessionPullRequest).not.toHaveBeenCalled();
    expect(updatedSessions).toEqual([
      { phase_status: "agent_generating" },
      { phase_status: "rejected" },
    ]);
    expect(mocked.formatGenerationFailureBlocks).toHaveBeenCalledTimes(1);
  });
});

// ---- handleRejection ----------------------------------------------------

interface RejectionMockOptions {
  session: Tables<"sessions"> | null;
  rejectionClaim?: { id: string } | null;
  rejectionClaimError?: { message: string } | null;
  slackInstall?: { bot_token_encrypted: string } | null;
  workspaceSecrets?: Record<string, string>;
  enqueueError?: { code?: string; message: string } | null;
  workspaceMember?: { id: string } | null;
}

function buildRejectionMock(opts: RejectionMockOptions) {
  const sessionUpdates: Array<Record<string, unknown>> = [];
  const artifactUpdates: Array<{ patch: Record<string, unknown> }> = [];
  const insertedFeedback: Array<Record<string, unknown>> = [];
  const enqueuedJobs: Array<Record<string, unknown>> = [];

  const sessionsTable = {
    select: () => ({
      eq: () => ({ maybeSingle: async () => ({ data: opts.session, error: null }) }),
    }),
    update: (patch: Record<string, unknown>) => {
      sessionUpdates.push(patch);
      // If this is the CAS rejection_count update, it has 5 .eq() calls
      // followed by .select().maybeSingle(). All other updates are plain.
      const builder: Record<string, unknown> = {};
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

  const slackTable = {
    select: () => ({
      eq: () => ({ maybeSingle: async () => ({ data: opts.slackInstall ?? null, error: null }) }),
    }),
  };

  const workspaceSecretsTable = {
    select: () => ({
      eq: () => ({
        eq: (_col: string, key: string) => ({
          maybeSingle: async () => ({
            data: opts.workspaceSecrets?.[key]
              ? { encrypted_value: opts.workspaceSecrets[key] }
              : null,
            error: null,
          }),
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
    insert: async (row: Record<string, unknown>) => {
      enqueuedJobs.push(row);
      return { error: opts.enqueueError ?? null };
    },
  };

  const feedbackTable = {
    insert: async (row: Record<string, unknown>) => {
      insertedFeedback.push(row);
      return { error: null };
    },
  };

  const tables: Record<string, unknown> = {
    sessions: sessionsTable,
    session_artifacts: artifactsTable,
    session_artifact_feedback: feedbackTable,
    slack_installations: slackTable,
    workspace_secrets: workspaceSecretsTable,
    workspace_members: workspaceMembersTable,
    agent_jobs: agentJobsTable,
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
      sessionId: "sess-1",
      version: 1,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("raced");
  });

  it("on a non-escalating rejection, writes feedback, enqueues a retry, then flips status to rejected", async () => {
    const session = baseSession({
      phase_status: "awaiting_review",
      current_artifact_version: 1,
      rejection_count: 0,
    });
    const { admin, sessionUpdates, insertedFeedback, enqueuedJobs } = buildRejectionMock({
      session,
      workspaceMember: { id: "mem-wallie" },
    });

    const result = await handleRejection({
      admin,
      expectedWorkspaceId: "ws-1",
      feedbackText: "tighten the spec",
      sessionId: "sess-1",
      version: 1,
    });

    expect(result.success).toBe(true);
    expect(result.escalated).toBe(false);
    // Feedback row recorded in session_artifact_feedback (post-WAL-14 split).
    expect(insertedFeedback).toHaveLength(1);
    expect(insertedFeedback[0]).toMatchObject({
      feedback_text: "tighten the spec",
      session_id: "sess-1",
      target_version: 1,
    });
    // Retry enqueued before flipping to rejected.
    expect(enqueuedJobs).toHaveLength(1);
    expect(enqueuedJobs[0]!.session_id).toBe("sess-1");
    expect(enqueuedJobs[0]!.requested_by_member_id).toBe("mem-wallie");
    // Session updates: rejection_count CAS first, then phase_status=rejected.
    expect(sessionUpdates[0]).toEqual({ rejection_count: 1 });
    expect(sessionUpdates.at(-1)).toEqual({ phase_status: "rejected" });
    // Crucially we don't escalate when below threshold.
    expect(sessionUpdates).not.toContainEqual({ phase_status: "escalated" });
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
      sessionId: "sess-1",
      version: 1,
    });
    expect(result.success).toBe(true);
    // Status flip still happens.
    expect(sessionUpdates.at(-1)).toEqual({ phase_status: "rejected" });
  });

  it("returns the enqueue error and stops *before* flipping to rejected when the retry can't be queued", async () => {
    // Rationale captured in processor.ts: a 'rejected' state with no queued
    // worker is a wedged state the UI can't recover from. We must not flip if
    // the enqueue failed for any reason other than a duplicate.
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
      sessionId: "sess-1",
      version: 1,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("queue write failed");
    expect(sessionUpdates).toEqual([{ rejection_count: 1 }]);
  });

  it("escalates when the rejection_count crosses the threshold (3) and DM payload is built from session + stage", async () => {
    // shouldEscalate returns true at >= 3; rejection_count was 2, so this
    // becomes the third rejection. With slack install + EM_SLACK_USER_ID set,
    // an escalation DM is dispatched.
    const session = baseSession({
      phase_status: "awaiting_review",
      current_artifact_version: 1,
      rejection_count: 2,
    });
    const { admin, sessionUpdates, enqueuedJobs } = buildRejectionMock({
      session,
      slackInstall: { bot_token_encrypted: "tok" },
      workspaceSecrets: { EM_SLACK_USER_ID: "U-em" },
    });
    const result = await handleRejection({
      admin,
      expectedWorkspaceId: "ws-1",
      feedbackText: "still wrong",
      sessionId: "sess-1",
      version: 1,
    });
    expect(result.success).toBe(true);
    expect(result.escalated).toBe(true);
    expect(sessionUpdates).toEqual([{ rejection_count: 3 }, { phase_status: "escalated" }]);
    // Escalation does NOT enqueue a retry — that's only for non-escalating rejections.
    expect(enqueuedJobs).toHaveLength(0);
    expect(mocked.openSlackDm).toHaveBeenCalledTimes(1);
    expect(mocked.formatEscalationDmBlocks).toHaveBeenCalledTimes(1);
    const dmBlocksArgs = (
      mocked.formatEscalationDmBlocks.mock.calls as unknown as Array<[Record<string, unknown>]>
    )[0]![0];
    expect(dmBlocksArgs.rejectionCount).toBe(3);
    expect(dmBlocksArgs.stageName).toBe(productStage.name);
  });

  it("escalates without crashing even when no Slack install or EM user id is configured", async () => {
    const session = baseSession({
      phase_status: "awaiting_review",
      current_artifact_version: 1,
      rejection_count: 2,
    });
    const { admin } = buildRejectionMock({
      session,
      slackInstall: null,
      workspaceSecrets: {},
    });
    const result = await handleRejection({
      admin,
      expectedWorkspaceId: "ws-1",
      feedbackText: "still wrong",
      sessionId: "sess-1",
      version: 1,
    });
    expect(result.success).toBe(true);
    expect(result.escalated).toBe(true);
    expect(mocked.openSlackDm).not.toHaveBeenCalled();
  });
});

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
});

describe("handleRejection", () => {
  function buildRejectionAdmin(opts: {
    session: Tables<"sessions">;
    feedbackInsertError?: { message: string; code?: string } | null;
  }) {
    const insertedFeedback: Array<Record<string, unknown>> = [];
    const updatedSessions: Array<Record<string, unknown>> = [];

    // Five-deep `.eq()` chain matches the rejection_count CAS in handleRejection.
    const eqChain = (terminal: () => unknown): unknown => {
      const node: Record<string, unknown> = {
        select: () => ({ maybeSingle: terminal }),
      };
      node.eq = () => node;
      return node;
    };

    const sessionsTable = {
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: opts.session, error: null }),
        }),
      }),
      update: (patch: Record<string, unknown>) => {
        updatedSessions.push(patch);
        return eqChain(async () => ({ data: { id: opts.session.id }, error: null }));
      },
    };

    const feedbackTable = {
      insert: async (row: Record<string, unknown>) => {
        insertedFeedback.push(row);
        return { error: opts.feedbackInsertError ?? null };
      },
    };

    const workspaceMembersTable = {
      select: () => ({
        eq: () => ({
          eq: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: { id: "mem-wallie" }, error: null }) }),
          }),
        }),
      }),
    };

    const agentJobsTable = {
      insert: async () => ({ error: null }),
    };

    const tables: Record<string, unknown> = {
      sessions: sessionsTable,
      session_artifact_feedback: feedbackTable,
      workspace_members: workspaceMembersTable,
      agent_jobs: agentJobsTable,
    };

    return {
      admin: createProcessorTestAdminClient({ from: (name: string) => tables[name] ?? {} }),
      insertedFeedback,
      updatedSessions,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocked.loadStageById.mockResolvedValue(productStage);
  });

  it("inserts a feedback row keyed on (session, stage, target_version) and does not write to session_artifacts", async () => {
    const session = baseSession({
      phase_status: "awaiting_review",
      current_artifact_version: 2,
      rejection_count: 0,
    });
    const { admin, insertedFeedback, updatedSessions } = buildRejectionAdmin({ session });

    const result = await handleRejection({
      admin,
      expectedWorkspaceId: session.workspace_id,
      feedbackText: "Add error handling section",
      sessionId: session.id,
      version: 2,
    });

    expect(result.success).toBe(true);
    expect(result.escalated).toBe(false);
    expect(insertedFeedback).toHaveLength(1);
    expect(insertedFeedback[0]).toEqual({
      feedback_text: "Add error handling section",
      session_id: session.id,
      stage_id: productStage.id,
      stage_slug: productStage.slug,
      target_version: 2,
      workspace_id: session.workspace_id,
    });
    expect(updatedSessions).toEqual([{ rejection_count: 1 }, { phase_status: "rejected" }]);
  });

  it("treats a 23505 feedback insert as idempotent so a retry after a prior enqueue failure can still flip phase_status and recover the session", async () => {
    const session = baseSession({
      phase_status: "awaiting_review",
      current_artifact_version: 1,
      rejection_count: 0,
    });
    const { admin, updatedSessions } = buildRejectionAdmin({
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
      sessionId: session.id,
      version: 1,
    });

    expect(result.success).toBe(true);
    expect(result.escalated).toBe(false);
    // Existing feedback row is canonical; the retry must still advance the
    // session — otherwise rejection_count is bumped with nothing queued.
    expect(updatedSessions).toEqual([{ rejection_count: 1 }, { phase_status: "rejected" }]);
  });

  it("aborts the rejection when the feedback insert fails with a non-23505 error", async () => {
    const session = baseSession({
      phase_status: "awaiting_review",
      current_artifact_version: 1,
      rejection_count: 0,
    });
    const { admin, updatedSessions } = buildRejectionAdmin({
      session,
      feedbackInsertError: { code: "23503", message: "foreign key violation" },
    });

    const result = await handleRejection({
      admin,
      expectedWorkspaceId: session.workspace_id,
      feedbackText: "boom",
      sessionId: session.id,
      version: 1,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("foreign key");
    expect(updatedSessions).toEqual([{ rejection_count: 1 }]);
  });
});
