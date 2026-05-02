import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Tables } from "@/lib/supabase/database.types";
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

import { handleApproval, processPipelineJob } from "./processor";

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
  /** Map of `key` → encrypted_value returned from `workspace_secrets`. */
  workspaceSecrets?: Record<string, string>;
  /** When set, github_installations.maybeSingle returns this row. Default: a row exists. */
  githubInstallation?: { id: string; installation_id: number } | null;
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
    select: () => ({
      eq: () => ({
        eq: () => ({
          order: () => ({
            limit: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
          }),
        }),
      }),
    }),
    update: () => ({
      eq: () => ({
        eq: () => ({
          eq: async () => ({ error: null }),
        }),
      }),
    }),
    delete: () => ({
      eq: () => ({
        eq: () => ({
          eq: async () => ({ error: null }),
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
    admin: {
      from: (name: string) => tables[name] ?? {},
      rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
    },
    insertedArtifacts,
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

    const result = await processPipelineJob({ admin: admin as never, job });

    expect(mocked.renderStagePrompt).toHaveBeenCalledTimes(1);
    expect(mocked.formatStageReviewBlocks).toHaveBeenCalledTimes(1);
    expect(mocked.postSlackMessage).toHaveBeenCalledTimes(1);
    expect(insertedArtifacts).toHaveLength(1);
    const artifact = insertedArtifacts[0]!;
    expect(artifact.stage_slug).toBe("product");
    expect(artifact.version).toBe(1);
    expect(artifact.artifact_json).toContain("Drafted spec body");
    // The pointer flip — find the update that set phase_status to awaiting_review.
    const flip = updatedSessions.find((u) => u.phase_status === "awaiting_review");
    expect(flip).toBeDefined();
    expect(result.result).toBe("success");
  });

  it("opens a session pull request after the artifact is persisted", async () => {
    const session = baseSession();
    const job = baseJob();
    const { admin } = buildAdminMock({
      session,
      slackInstall: { bot_token_encrypted: "tok" },
    });

    await processPipelineJob({ admin: admin as never, job });

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

    const result = await processPipelineJob({ admin: admin as never, job: baseJob() });

    expect(insertedArtifacts).toHaveLength(1);
    expect(updatedSessions.find((u) => u.phase_status === "awaiting_review")).toBeDefined();
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
    const result = await processPipelineJob({ admin: admin as never, job: baseJob() });
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

    const result = await processPipelineJob({ admin: admin as never, job });

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
    const result = await processPipelineJob({ admin: admin as never, job: baseJob() });
    expect(result.result).toBe("error");
    expect(mocked.createSessionSandbox).not.toHaveBeenCalled();
  });

  it("errors out cleanly when the workspace has no Slack installation", async () => {
    const session = baseSession();
    const { admin } = buildAdminMock({
      session,
      slackInstall: null,
    });
    const result = await processPipelineJob({ admin: admin as never, job: baseJob() });
    expect(result.result).toBe("error");
    expect(mocked.renderStagePrompt).not.toHaveBeenCalled();
  });
});

describe("handleApproval", () => {
  it("calls approve_session_stage with the approver id and returns success on a non-empty result", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [{ id: "sess-1", current_stage_id: "stage-design" }],
      error: null,
    });
    const admin = { rpc } as never;
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
      admin: { rpc } as never,
      approverMemberId: null,
      expectedWorkspaceId: "ws-1",
      sessionId: "sess-1",
      version: 1,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("not authorized");
  });
});
