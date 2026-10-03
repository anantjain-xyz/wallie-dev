import type { PostgrestError } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Tables } from "@/lib/supabase/database.types";
import {
  assertSessionFirstRunReady,
  createSessionWithFirstJob,
  enqueueSessionJobWithRun,
  retryWallieRun,
} from "@/lib/wallie/service";
import { SandboxCapabilityCheckStaleError } from "@/lib/sandbox-capabilities/readiness";

const mocks = vi.hoisted(() => ({
  assertCurrentSandboxCapabilityCheck: vi.fn(),
  loadWorkspaceSandboxOverview: vi.fn(),
  resolveSandboxImplementation: vi.fn(() => "vercel"),
}));

vi.mock("@/lib/sandbox-connections/server", () => ({
  loadWorkspaceSandboxOverview: mocks.loadWorkspaceSandboxOverview,
  providerLabel: () => "Vercel Sandbox",
}));

vi.mock("@/lib/sandbox", () => ({
  resolveSandboxImplementation: mocks.resolveSandboxImplementation,
}));

vi.mock("@/lib/sandbox-capabilities/readiness", async () => {
  const actual = await vi.importActual<typeof import("@/lib/sandbox-capabilities/readiness")>(
    "@/lib/sandbox-capabilities/readiness",
  );
  return {
    ...actual,
    assertCurrentSandboxCapabilityCheck: mocks.assertCurrentSandboxCapabilityCheck,
  };
});

beforeEach(() => {
  mocks.assertCurrentSandboxCapabilityCheck.mockReset();
  mocks.assertCurrentSandboxCapabilityCheck.mockResolvedValue(undefined);
  mocks.loadWorkspaceSandboxOverview.mockReset();
  mocks.resolveSandboxImplementation.mockReset();
  mocks.resolveSandboxImplementation.mockReturnValue("vercel");
  mocks.loadWorkspaceSandboxOverview.mockResolvedValue({
    activeProvider: "vercel",
    connections: {
      daytona: null,
      e2b: null,
      vercel: {
        connectionRevision: "revision-1",
        lastValidatedAt: baseTimestamp,
        lastValidationError: null,
        projectId: "prj_123",
        projectName: "wallie-sandboxes",
        status: "connected",
        teamId: "team_123",
        tokenPreview: "verc...1234",
        updatedAt: baseTimestamp,
        workspaceId: "ws-1",
      },
    },
    enabledProviders: ["vercel", "e2b", "daytona"],
    revision: 1,
    updatedAt: baseTimestamp,
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("wallie service helpers", () => {
  it("creates a session and its first job with one RPC mutation", async () => {
    const rpc = vi.fn(() => ({
      single: async () => ({
        data: {
          job_id: "job-1",
          run_id: "run-1",
          session_id: "session-1",
          session_number: 42,
          workspace_slug: "acme",
        },
        error: null,
      }),
    }));

    const result = await createSessionWithFirstJob({
      admin: { rpc } as unknown as NonNullable<
        Parameters<typeof createSessionWithFirstJob>[0]["admin"]
      >,
      creatorMemberId: "member-1",
      githubRepositoryId: null,
      linearIssueId: null,
      linearIssueUrl: null,
      modelName: "gpt-5.5",
      modelProvider: "codex",
      promptMd: "Create it atomically.",
      selectedStageIds: ["stage-build", "stage-land"],
      title: "Atomic create",
      workspaceId: "workspace-1",
    });

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("create_session_with_first_job_and_attachments", {
      agent_model_name: "gpt-5.5",
      agent_model_provider: "codex",
      creator_member_id: "member-1",
      selected_pipeline_id: undefined,
      selected_stage_ids: ["stage-build", "stage-land"],
      session_attachment_ids: [],
      session_github_repository_id: undefined,
      session_linear_issue_id: undefined,
      session_linear_issue_url: undefined,
      session_prompt_md: "Create it atomically.",
      session_title: "Atomic create",
      target_workspace_id: "workspace-1",
    });
    expect(result).toEqual({
      jobId: "job-1",
      number: 42,
      runId: "run-1",
      sessionId: "session-1",
      workspaceSlug: "acme",
    });
  });

  it("blocks first-run prep when the resolved repository is archived", () => {
    expect(() =>
      assertSessionFirstRunReady({
        agentConfig: { effort: "xhigh", model: "gpt-5.5", provider: "codex" },
        repository: {
          defaultBranch: "main",
          defaultProgrammingLanguage: "TypeScript",
          fullName: "acme/archived",
          htmlUrl: "https://github.com/acme/archived",
          id: "repo-archived",
          isArchived: true,
          isPrivate: false,
        },
        vercelSandboxConnection: {
          connected: true,
          lastValidationError: null,
          projectId: "prj_123",
          projectName: "wallie-sandboxes",
          status: "connected",
          teamId: "team_123",
        },
      }),
    ).toThrow(/archived repository/i);
  });
});

// ---- retry enqueue path: regression for WAL-3 ---------------------------
//
// The queued `agent_runs` row used to be stamped with the literal placeholder
// "wallie-control-plane-stub". Here we drive the public retry path with a
// fake admin/server client and assert the RPC receives the model the
// workspace has configured.

interface AgentConfigRow {
  key: string;
  value_json: unknown;
}

type AgentRunRow = Tables<"agent_runs">;
type QueryResult = Promise<{ data: unknown; error: PostgrestError | null }>;
type QueryBuilder = {
  abortSignal: (signal: AbortSignal) => QueryBuilder;
  eq: (column: string, value: unknown) => QueryBuilder;
  in: (column: string, value: unknown) => QueryBuilder;
  limit: (count: number) => QueryBuilder;
  maybeSingle: () => QueryResult;
  order: (column: string, options?: unknown) => QueryBuilder;
};

const baseTimestamp = "2026-01-01T00:00:00.000Z";

function buildAgentRunRow(overrides: Partial<AgentRunRow> = {}): AgentRunRow {
  return {
    agent_job_id: "job-1",
    attempt_count: null,
    branch_name: null,
    created_at: baseTimestamp,
    finished_at: null,
    id: "run-1",
    input_tokens: null,
    last_activity_at: null,
    model_name: "claude-sonnet-4-20250514",
    model_provider: "claude-code",
    output_tokens: null,
    run_type: "project",
    sandbox_id: null,
    sandbox_provider: null,
    sandbox_connection_revision: null,
    sandbox_vercel_project_id: null,
    sandbox_vercel_team_id: null,
    session_id: "sess-1",
    started_at: null,
    stage_id: null,
    stage_name: null,
    stage_slug: null,
    status: "queued",
    total_cost_usd: null,
    triggered_by_member_id: "mem-1",
    updated_at: baseTimestamp,
    workspace_id: "ws-1",
    ...overrides,
  };
}

function createMaybeSingleQuery(
  resolve: (filters: Map<string, unknown>, signal: AbortSignal | undefined) => QueryResult,
): QueryBuilder {
  const filters = new Map<string, unknown>();
  let signal: AbortSignal | undefined;
  const builder: QueryBuilder = {
    abortSignal: (nextSignal) => {
      signal = nextSignal;
      return builder;
    },
    eq: (column, value) => {
      filters.set(column, value);
      return builder;
    },
    in: (column, value) => {
      filters.set(column, value);
      return builder;
    },
    limit: () => builder,
    maybeSingle: () => resolve(filters, signal),
    order: () => builder,
  };

  return builder;
}

function buildSupabaseMocks(opts: {
  agentConfig: AgentConfigRow[];
  activeRunForSession?: AgentRunRow | null;
  archivedAt?: string | null;
  phaseStatus?: string;
  enqueueCalls: Array<Record<string, unknown>>;
  enqueueError?: PostgrestError | null;
  enqueueReceipt?: { created: boolean; job_id: string; run_id: string | null };
  receiptRun?: AgentRunRow | null;
  existingRun?: AgentRunRow | null;
  primaryRepositoryId?: string | null;
  repositories?: Array<{
    default_branch?: string | null;
    default_programming_language?: string | null;
    full_name: string;
    github_installation_id?: string;
    html_url?: string;
    id: string;
    is_archived?: boolean;
    private?: boolean;
    workspace_id?: string;
  }>;
  loadRunByJobId?: (
    signal: AbortSignal | undefined,
  ) => Promise<AgentRunRow | null> | AgentRunRow | null;
}) {
  const sessionRow = {
    archived_at: opts.archivedAt ?? null,
    current_stage_id: "stage-product",
    github_repository_id: null,
    id: "sess-1",
    workspace_id: "ws-1",
    number: 1,
    phase_status: opts.phaseStatus ?? "rejected",
    title: "Add SSO",
    prompt_md: "Add SSO via Google Workspace",
    created_at: baseTimestamp,
  };

  const supabase = {
    from: (table: string) => {
      if (table === "sessions") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: sessionRow, error: null }),
              }),
            }),
          }),
        };
      }
      if (table === "session_pull_requests") {
        return {
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
      }
      throw new Error(`unexpected supabase table: ${table}`);
    },
  };

  let queuedRun: AgentRunRow | null | undefined;
  let receiptRunId: string | null = null;
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name !== "enqueue_session_job_with_run") throw new Error(`unexpected RPC: ${name}`);
    opts.enqueueCalls.push(args);
    if (opts.enqueueError) return { data: null, error: opts.enqueueError };
    const receipt = opts.enqueueReceipt ?? {
      created: true,
      job_id: "job-queued",
      run_id: "run-queued",
    };
    receiptRunId = receipt.run_id;
    if (receipt.run_id) {
      queuedRun =
        opts.receiptRun === undefined
          ? buildAgentRunRow({ agent_job_id: receipt.job_id, id: receipt.run_id })
          : opts.receiptRun;
    }
    return { data: [receipt], error: null };
  });

  const admin = {
    rpc,
    from: (table: string) => {
      if (table === "sessions") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: sessionRow, error: null }),
              }),
            }),
          }),
        };
      }
      if (table === "agent_runs") {
        return {
          select: () =>
            createMaybeSingleQuery(async (filters, signal) => {
              if (filters.has("agent_job_id")) {
                return {
                  data: opts.loadRunByJobId ? await opts.loadRunByJobId(signal) : null,
                  error: null,
                };
              }

              if (filters.has("id")) {
                return {
                  data:
                    receiptRunId === filters.get("id")
                      ? (queuedRun ?? null)
                      : opts.existingRun === undefined
                        ? buildAgentRunRow({ finished_at: baseTimestamp, status: "error" })
                        : opts.existingRun,
                  error: null,
                };
              }

              return { data: opts.activeRunForSession ?? null, error: null };
            }),
        };
      }
      if (table === "session_pull_requests") {
        return {
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
      }
      if (table === "workspace_repository_profiles") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: opts.primaryRepositoryId
                    ? { github_repository_id: opts.primaryRepositoryId }
                    : null,
                  error: null,
                }),
              }),
            }),
          }),
        };
      }
      if (table === "workspace_onboarding") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: null, error: null }),
            }),
          }),
        };
      }
      if (table === "github_repositories") {
        return {
          select: () => {
            const filters = new Map<string, unknown>();
            const builder = {
              eq: (column: string, value: unknown) => {
                filters.set(column, value);
                return builder;
              },
              maybeSingle: async () => {
                const row = (opts.repositories ?? []).find(
                  (candidate) =>
                    candidate.id === filters.get("id") &&
                    (candidate.workspace_id ?? "ws-1") === filters.get("workspace_id"),
                );

                return {
                  data: row
                    ? {
                        default_branch: row.default_branch ?? "main",
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
            };
            return builder;
          },
        };
      }
      if (table === "workspace_agent_config") {
        return {
          select: () => ({
            eq: () => ({
              in: async () => ({ data: opts.agentConfig, error: null }),
            }),
          }),
        };
      }
      throw new Error(`unexpected admin table: ${table}`);
    },
  };

  return {
    rpc,
    admin: admin as unknown as Parameters<typeof retryWallieRun>[0]["admin"],
    supabase: supabase as unknown as Parameters<typeof retryWallieRun>[0]["supabase"],
  };
}

describe("retryWallieRun queued run configuration (WAL-3 regression)", () => {
  it("stamps the queued run with the workspace's configured model and provider", async () => {
    const enqueueCalls: Array<Record<string, unknown>> = [];
    const { admin, supabase } = buildSupabaseMocks({
      agentConfig: [
        { key: "agent_model", value_json: "claude-sonnet-4-20250514" },
        { key: "agent_provider", value_json: "claude_code" },
      ],
      enqueueCalls,
    });

    const result = await retryWallieRun({
      admin,
      runId: "run-1",
      requestedByMemberId: "mem-1",
      supabase,
      workspace: { id: "ws-1", name: "Acme", slug: "acme" },
    });

    expect(result.created).toBe(true);
    expect(enqueueCalls).toHaveLength(1);
    const inserted = enqueueCalls[0]!;
    expect(inserted.p_agent_model_name).toBe("claude-sonnet-4-20250514");
    expect(inserted.p_agent_model_name).not.toBe("wallie-control-plane-stub");
    // Underscore aliases that the settings UI persists must be normalized to
    // the canonical dashed form runners expect.
    expect(inserted.p_agent_model_provider).toBe("claude-code");
    expect(inserted.p_expected_stage_id).toBe("stage-product");
  });

  it("refuses to enqueue a run for an archived session", async () => {
    const enqueueCalls: Array<Record<string, unknown>> = [];
    const { admin, supabase } = buildSupabaseMocks({
      agentConfig: [],
      archivedAt: "2026-06-07T12:00:00.000Z",
      enqueueCalls,
    });

    await expect(
      retryWallieRun({
        admin,
        runId: "run-1",
        requestedByMemberId: "mem-1",
        supabase,
        workspace: { id: "ws-1", name: "Acme", slug: "acme" },
      }),
    ).rejects.toMatchObject({ code: "session_archived" });

    expect(enqueueCalls).toHaveLength(0);
  });

  it("refuses to enqueue a run for a completed (approved) session", async () => {
    const enqueueCalls: Array<Record<string, unknown>> = [];
    const { admin, supabase } = buildSupabaseMocks({
      agentConfig: [],
      phaseStatus: "approved",
      enqueueCalls,
    });

    await expect(
      retryWallieRun({
        admin,
        runId: "run-1",
        requestedByMemberId: "mem-1",
        supabase,
        workspace: { id: "ws-1", name: "Acme", slug: "acme" },
      }),
    ).rejects.toMatchObject({ code: "session_not_runnable" });

    expect(enqueueCalls).toHaveLength(0);
  });

  it("falls back to the runner default when the workspace has not configured a model", async () => {
    const enqueueCalls: Array<Record<string, unknown>> = [];
    const { admin, supabase } = buildSupabaseMocks({
      agentConfig: [],
      enqueueCalls,
    });

    await retryWallieRun({
      admin,
      runId: "run-1",
      requestedByMemberId: "mem-1",
      supabase,
      workspace: { id: "ws-1", name: "Acme", slug: "acme" },
    });

    const inserted = enqueueCalls[0]!;
    expect(inserted.p_agent_model_name).not.toBe("wallie-control-plane-stub");
    expect(typeof inserted.p_agent_model_name).toBe("string");
    expect((inserted.p_agent_model_name as string).length).toBeGreaterThan(0);
    expect(typeof inserted.p_agent_model_provider).toBe("string");
    expect((inserted.p_agent_model_provider as string).length).toBeGreaterThan(0);
  });

  it("preserves code mode from the original run when retrying", async () => {
    const enqueueCalls: Array<Record<string, unknown>> = [];
    const { admin, supabase } = buildSupabaseMocks({
      agentConfig: [],
      existingRun: buildAgentRunRow({
        finished_at: baseTimestamp,
        run_type: "code",
        status: "error",
      }),
      enqueueCalls,
      primaryRepositoryId: "repo-1",
      repositories: [{ full_name: "acme/app", id: "repo-1" }],
    });

    await retryWallieRun({
      admin,
      runId: "run-1",
      requestedByMemberId: "mem-1",
      supabase,
      workspace: { id: "ws-1", name: "Acme", slug: "acme" },
    });

    expect(enqueueCalls[0]!.p_run_type).toBe("code");
  });

  it("returns the affected provider when its capability check is stale", async () => {
    mocks.loadWorkspaceSandboxOverview.mockResolvedValueOnce({
      activeProvider: "e2b",
      connections: {
        daytona: null,
        e2b: {
          apiKeyPreview: "e2b_...1234",
          connectionRevision: "revision-e2b",
          lastValidatedAt: baseTimestamp,
          lastValidationError: null,
          status: "connected",
          updatedAt: baseTimestamp,
          workspaceId: "ws-1",
        },
        vercel: null,
      },
      enabledProviders: ["vercel", "e2b", "daytona"],
      revision: 2,
      updatedAt: baseTimestamp,
    });
    mocks.assertCurrentSandboxCapabilityCheck.mockRejectedValueOnce(
      new SandboxCapabilityCheckStaleError("e2b"),
    );
    const enqueueCalls: Array<Record<string, unknown>> = [];
    const { admin, supabase } = buildSupabaseMocks({
      agentConfig: [],
      enqueueCalls,
      primaryRepositoryId: "repo-1",
      repositories: [{ full_name: "acme/app", id: "repo-1" }],
    });

    await expect(
      retryWallieRun({
        admin,
        runId: "run-1",
        requestedByMemberId: "mem-1",
        supabase,
        workspace: { id: "ws-1", name: "Acme", slug: "acme" },
      }),
    ).rejects.toMatchObject({
      code: "sandbox_capability_check_stale",
      provider: "e2b",
      statusCode: 422,
    });
    expect(enqueueCalls).toHaveLength(0);
  });

  it("blocks code mode when the configured repository id does not resolve", async () => {
    const enqueueCalls: Array<Record<string, unknown>> = [];
    const { admin, supabase } = buildSupabaseMocks({
      agentConfig: [],
      existingRun: buildAgentRunRow({
        finished_at: baseTimestamp,
        run_type: "code",
        status: "error",
      }),
      enqueueCalls,
      primaryRepositoryId: "repo-missing",
      repositories: [],
    });

    await expect(
      retryWallieRun({
        admin,
        runId: "run-1",
        requestedByMemberId: "mem-1",
        supabase,
        workspace: { id: "ws-1", name: "Acme", slug: "acme" },
      }),
    ).rejects.toMatchObject({
      code: "repository_unavailable",
      statusCode: 422,
    });

    expect(enqueueCalls).toHaveLength(0);
  });

  it("blocks queued runs when the workspace Vercel Sandbox connection is missing", async () => {
    mocks.loadWorkspaceSandboxOverview.mockResolvedValueOnce({
      activeProvider: "vercel",
      connections: { daytona: null, e2b: null, vercel: null },
      enabledProviders: ["vercel", "e2b", "daytona"],
      revision: 1,
      updatedAt: baseTimestamp,
    });
    const enqueueCalls: Array<Record<string, unknown>> = [];
    const { admin, supabase } = buildSupabaseMocks({
      agentConfig: [],
      enqueueCalls,
    });

    await expect(
      retryWallieRun({
        admin,
        runId: "run-1",
        requestedByMemberId: "mem-1",
        supabase,
        workspace: { id: "ws-1", name: "Acme", slug: "acme" },
      }),
    ).rejects.toMatchObject({
      code: "sandbox_connection_missing",
      statusCode: 422,
    });

    expect(enqueueCalls).toHaveLength(0);
  });

  it("blocks queued runs when the active sandbox provider is disabled", async () => {
    mocks.loadWorkspaceSandboxOverview.mockResolvedValueOnce({
      activeProvider: "e2b",
      connections: {
        daytona: null,
        e2b: {
          apiKeyPreview: "e2b_...1234",
          connectionRevision: "revision-e2b",
          lastValidatedAt: baseTimestamp,
          lastValidationError: null,
          status: "connected",
          updatedAt: baseTimestamp,
          workspaceId: "ws-1",
        },
        vercel: null,
      },
      enabledProviders: ["vercel"],
      revision: 2,
      updatedAt: baseTimestamp,
    });
    const enqueueCalls: Array<Record<string, unknown>> = [];
    const { admin, supabase } = buildSupabaseMocks({
      agentConfig: [],
      enqueueCalls,
      primaryRepositoryId: "repo-1",
      repositories: [{ full_name: "acme/app", id: "repo-1" }],
    });

    await expect(
      retryWallieRun({
        admin,
        runId: "run-1",
        requestedByMemberId: "mem-1",
        supabase,
        workspace: { id: "ws-1", name: "Acme", slug: "acme" },
      }),
    ).rejects.toMatchObject({
      code: "sandbox_connection_invalid",
      provider: "e2b",
      statusCode: 422,
    });
    expect(mocks.assertCurrentSandboxCapabilityCheck).not.toHaveBeenCalled();
    expect(enqueueCalls).toHaveLength(0);
  });

  it("blocks queued runs when Daytona's saved control plane is no longer allowed", async () => {
    mocks.loadWorkspaceSandboxOverview.mockResolvedValueOnce({
      activeProvider: "daytona",
      connections: {
        daytona: {
          apiKeyPreview: "daytona_…1234",
          apiUrl: "https://retired-daytona.example/api",
          connectionRevision: "revision-daytona",
          lastValidatedAt: baseTimestamp,
          lastValidationError: "Daytona API URL is not allowed by this Wallie deployment.",
          status: "error",
          target: null,
          updatedAt: baseTimestamp,
          workspaceId: "ws-1",
        },
        e2b: null,
        vercel: null,
      },
      enabledProviders: ["vercel", "e2b", "daytona"],
      revision: 2,
      updatedAt: baseTimestamp,
    });
    const enqueueCalls: Array<Record<string, unknown>> = [];
    const { admin, supabase } = buildSupabaseMocks({
      agentConfig: [],
      enqueueCalls,
      primaryRepositoryId: "repo-1",
      repositories: [{ full_name: "acme/app", id: "repo-1" }],
    });

    await expect(
      retryWallieRun({
        admin,
        runId: "run-1",
        requestedByMemberId: "mem-1",
        supabase,
        workspace: { id: "ws-1", name: "Acme", slug: "acme" },
      }),
    ).rejects.toMatchObject({
      code: "sandbox_connection_invalid",
      provider: "daytona",
      statusCode: 422,
    });
    expect(mocks.assertCurrentSandboxCapabilityCheck).not.toHaveBeenCalled();
    expect(enqueueCalls).toHaveLength(0);
  });

  it("allows queued runs without a Vercel connection when fake sandbox execution is selected", async () => {
    mocks.resolveSandboxImplementation.mockReturnValueOnce("fake");
    mocks.loadWorkspaceSandboxOverview.mockResolvedValueOnce({
      activeProvider: "vercel",
      connections: { daytona: null, e2b: null, vercel: null },
      enabledProviders: ["vercel", "e2b", "daytona"],
      revision: 1,
      updatedAt: baseTimestamp,
    });
    const enqueueCalls: Array<Record<string, unknown>> = [];
    const { admin, supabase } = buildSupabaseMocks({
      agentConfig: [],
      enqueueCalls,
    });

    await retryWallieRun({
      admin,
      runId: "run-1",
      requestedByMemberId: "mem-1",
      supabase,
      workspace: { id: "ws-1", name: "Acme", slug: "acme" },
    });

    expect(enqueueCalls).toHaveLength(1);
  });
});

describe("retryWallieRun legacy runless job compatibility", () => {
  it("acknowledges accepted work without waiting for a capacity-blocked worker", async () => {
    vi.useFakeTimers();
    const lookup = vi.fn(() => null);
    const { admin, supabase } = buildSupabaseMocks({
      agentConfig: [],
      enqueueCalls: [],
      enqueueReceipt: { created: false, job_id: "job-existing", run_id: null },
      loadRunByJobId: lookup,
    });

    const result = await retryWallieRun({
      admin,
      runId: "run-1",
      requestedByMemberId: "mem-1",
      supabase,
      workspace: { id: "ws-1", name: "Acme", slug: "acme" },
    });

    expect(result).toEqual({ created: false, jobId: "job-existing", run: null });
    expect(lookup).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("enqueueSessionJobWithRun atomic receipt", () => {
  it("uses the committed existing run receipt without legacy polling or direct mutations", async () => {
    const enqueueCalls: Array<Record<string, unknown>> = [];
    const legacyLookup = vi.fn();
    const { admin, rpc } = buildSupabaseMocks({
      agentConfig: [],
      enqueueCalls,
      enqueueReceipt: { created: false, job_id: "job-legacy", run_id: "run-legacy" },
      receiptRun: buildAgentRunRow({
        agent_job_id: "job-legacy",
        id: "run-legacy",
        status: "running",
      }),
      loadRunByJobId: legacyLookup,
    });
    const result = await enqueueSessionJobWithRun({
      admin: admin!,
      requestedByMemberId: "mem-1",
      runType: "project",
      session: { id: "sess-1", workspace_id: "ws-1", current_stage_id: "stage-product" },
      triggerType: "manual_retry",
    });
    expect(result).toMatchObject({
      created: false,
      jobId: "job-legacy",
      run: { id: "run-legacy", status: "running" },
    });
    expect(rpc).toHaveBeenCalledExactlyOnceWith(
      "enqueue_session_job_with_run",
      expect.objectContaining({
        p_session_id: "sess-1",
        p_workspace_id: "ws-1",
        p_expected_stage_id: "stage-product",
        p_requested_by_member_id: "mem-1",
        p_trigger_type: "manual_retry",
        p_run_type: "project",
      }),
    );
    expect(legacyLookup).not.toHaveBeenCalled();
  });

  it.each(["success", "error", "canceled", null] as const)(
    "preserves an accepted job when its receipt run becomes %s before it is fetched",
    async (status) => {
      const { admin } = buildSupabaseMocks({
        agentConfig: [],
        enqueueCalls: [],
        enqueueReceipt: { created: false, job_id: "job-legacy", run_id: "run-legacy" },
        receiptRun: status
          ? buildAgentRunRow({ agent_job_id: "job-legacy", id: "run-legacy", status })
          : null,
      });
      const result = await enqueueSessionJobWithRun({
        admin: admin!,
        requestedByMemberId: "mem-1",
        runType: "project",
        session: { id: "sess-1", workspace_id: "ws-1", current_stage_id: "stage-product" },
        triggerType: "manual_retry",
      });
      expect(result).toEqual({ created: false, jobId: "job-legacy", run: null });
    },
  );

  it("propagates an atomic enqueue failure without compensating deletes or polling", async () => {
    const failure = {
      code: "55000",
      details: "",
      hint: "",
      message: "Session stage changed.",
      name: "PostgrestError",
    } satisfies PostgrestError;
    const legacyLookup = vi.fn();
    const { admin, rpc } = buildSupabaseMocks({
      agentConfig: [],
      enqueueCalls: [],
      enqueueError: failure,
      loadRunByJobId: legacyLookup,
    });
    await expect(
      enqueueSessionJobWithRun({
        admin: admin!,
        requestedByMemberId: "mem-1",
        runType: "project",
        session: { id: "sess-1", workspace_id: "ws-1", current_stage_id: "stage-product" },
        triggerType: "manual_retry",
      }),
    ).rejects.toEqual(failure);
    expect(rpc).toHaveBeenCalledOnce();
    expect(legacyLookup).not.toHaveBeenCalled();
  });
});
