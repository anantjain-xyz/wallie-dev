import type { PostgrestError } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Tables } from "@/lib/supabase/database.types";
import { claimQueuedJobCandidate, enqueueWallieRun } from "@/lib/wallie/service";

vi.mock("@/lib/pipeline/processor", () => ({
  processPipelineJob: vi.fn(),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("wallie service helpers", () => {
  it("claims the first candidate that wins the race", async () => {
    const candidates = [
      { id: "job-1", status: "queued" },
      { id: "job-2", status: "queued" },
      { id: "job-3", status: "queued" },
    ] as const;
    const attempts: string[] = [];

    const claimed = await claimQueuedJobCandidate(candidates, async (job) => {
      attempts.push(job.id);

      if (job.id === "job-1") {
        return null;
      }

      return job;
    });

    expect(attempts).toEqual(["job-1", "job-2"]);
    expect(claimed?.id).toBe("job-2");
  });
});

// ---- enqueue path: regression for WAL-3 ---------------------------------
//
// The queued `agent_runs` row used to be stamped with the literal placeholder
// "wallie-control-plane-stub". Here we drive the public enqueue path with a
// fake admin/server client and assert the row instead carries the model the
// workspace has configured.

interface AgentConfigRow {
  key: string;
  value_json: unknown;
}

type AgentJobRow = Tables<"agent_jobs">;
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

const uniqueViolationError = {
  code: "23505",
  details: "",
  hint: "",
  message: "duplicate key value violates unique constraint",
  name: "PostgrestError",
} satisfies PostgrestError;

function buildAgentJobRow(overrides: Partial<AgentJobRow> = {}): AgentJobRow {
  return {
    attempt_count: 0,
    created_at: baseTimestamp,
    dedupe_key: "session:sess-1:active",
    finished_at: null,
    id: "job-1",
    job_type: "session",
    last_error: null,
    requested_by_member_id: "mem-1",
    scheduled_at: null,
    session_id: "sess-1",
    started_at: null,
    stage_id: null,
    stage_name: null,
    stage_slug: null,
    status: "queued",
    trigger_type: "manual_run",
    updated_at: baseTimestamp,
    workspace_id: "ws-1",
    ...overrides,
  };
}

function buildAgentRunRow(overrides: Partial<AgentRunRow> = {}): AgentRunRow {
  return {
    agent_job_id: "job-1",
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
  activeJobRow?: AgentJobRow | null;
  activeRunForSession?: AgentRunRow | null;
  insertedJobRow?: AgentJobRow;
  insertedRunRows: Array<Record<string, unknown>>;
  jobInsertError?: PostgrestError | null;
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
    current_stage_id: "stage-product",
    id: "sess-1",
    workspace_id: "ws-1",
    number: 1,
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

  const insertedJobRow = opts.insertedJobRow ?? buildAgentJobRow();

  const admin = {
    from: (table: string) => {
      if (table === "workspace_secrets") {
        // No missing required secrets.
        return {
          select: () => ({
            eq: () => ({
              in: async () => ({
                data: [],
                error: null,
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

              return { data: opts.activeRunForSession ?? null, error: null };
            }),
          insert: (row: Record<string, unknown>) => {
            opts.insertedRunRows.push(row);
            return {
              select: () => ({
                single: async () => ({
                  data: buildAgentRunRow({
                    ...(row as Partial<AgentRunRow>),
                    id: "run-1",
                  }),
                  error: null,
                }),
              }),
            };
          },
        };
      }
      if (table === "agent_jobs") {
        return {
          insert: () => ({
            select: () => ({
              single: async () => ({
                data: opts.jobInsertError ? null : insertedJobRow,
                error: opts.jobInsertError ?? null,
              }),
            }),
          }),
          select: () =>
            createMaybeSingleQuery(async () => ({
              data: opts.activeJobRow ?? insertedJobRow,
              error: null,
            })),
        };
      }
      if (table === "pipeline_stages") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { id: "stage-product", name: "Product", slug: "product" },
                error: null,
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
    admin: admin as unknown as Parameters<typeof enqueueWallieRun>[0]["admin"],
    supabase: supabase as unknown as Parameters<typeof enqueueWallieRun>[0]["supabase"],
  };
}

describe("enqueueWallieRun queued agent_runs row (WAL-3 regression)", () => {
  it("stamps the queued run with the workspace's configured model and provider", async () => {
    const insertedRunRows: Array<Record<string, unknown>> = [];
    const { admin, supabase } = buildSupabaseMocks({
      agentConfig: [
        { key: "agent_model", value_json: "claude-sonnet-4-20250514" },
        { key: "agent_provider", value_json: "claude_code" },
      ],
      insertedRunRows,
    });

    const result = await enqueueWallieRun({
      admin,
      sessionId: "sess-1",
      requestedByMemberId: "mem-1",
      supabase,
      triggerType: "manual_run",
      workspace: { id: "ws-1", name: "Acme", slug: "acme" },
    });

    expect(result.created).toBe(true);
    expect(insertedRunRows).toHaveLength(1);
    const inserted = insertedRunRows[0]!;
    expect(inserted.model_name).toBe("claude-sonnet-4-20250514");
    expect(inserted.model_name).not.toBe("wallie-control-plane-stub");
    // Underscore aliases that the settings UI persists must be normalized to
    // the canonical dashed form runners expect.
    expect(inserted.model_provider).toBe("claude-code");
    expect(inserted.stage_id).toBe("stage-product");
    expect(inserted.stage_name).toBe("Product");
    expect(inserted.stage_slug).toBe("product");
  });

  it("falls back to the runner default when the workspace has not configured a model", async () => {
    const insertedRunRows: Array<Record<string, unknown>> = [];
    const { admin, supabase } = buildSupabaseMocks({
      agentConfig: [],
      insertedRunRows,
    });

    await enqueueWallieRun({
      admin,
      sessionId: "sess-1",
      requestedByMemberId: "mem-1",
      supabase,
      triggerType: "manual_run",
      workspace: { id: "ws-1", name: "Acme", slug: "acme" },
    });

    const inserted = insertedRunRows[0]!;
    expect(inserted.model_name).not.toBe("wallie-control-plane-stub");
    expect(typeof inserted.model_name).toBe("string");
    expect((inserted.model_name as string).length).toBeGreaterThan(0);
    expect(typeof inserted.model_provider).toBe("string");
    expect((inserted.model_provider as string).length).toBeGreaterThan(0);
  });

  it("uses the effective workspace repository to choose code mode for queued runs", async () => {
    const insertedRunRows: Array<Record<string, unknown>> = [];
    const { admin, supabase } = buildSupabaseMocks({
      agentConfig: [],
      insertedRunRows,
      primaryRepositoryId: "repo-1",
      repositories: [{ full_name: "acme/app", id: "repo-1" }],
    });

    await enqueueWallieRun({
      admin,
      sessionId: "sess-1",
      requestedByMemberId: "mem-1",
      supabase,
      triggerType: "manual_run",
      workspace: { id: "ws-1", name: "Acme", slug: "acme" },
    });

    expect(insertedRunRows[0]!.run_type).toBe("code");
  });

  it("blocks code mode when the configured repository id does not resolve", async () => {
    const insertedRunRows: Array<Record<string, unknown>> = [];
    const { admin, supabase } = buildSupabaseMocks({
      agentConfig: [],
      insertedRunRows,
      primaryRepositoryId: "repo-missing",
      repositories: [],
    });

    await expect(
      enqueueWallieRun({
        admin,
        sessionId: "sess-1",
        requestedByMemberId: "mem-1",
        supabase,
        triggerType: "manual_run",
        workspace: { id: "ws-1", name: "Acme", slug: "acme" },
      }),
    ).rejects.toMatchObject({
      code: "repository_unavailable",
      statusCode: 422,
    });

    expect(insertedRunRows).toHaveLength(0);
  });
});

describe("enqueueWallieRun duplicate job dedupe", () => {
  it("returns the existing run when run visibility is delayed beyond the old 200 ms window", async () => {
    vi.useFakeTimers();
    const startTime = Date.parse(baseTimestamp);
    vi.setSystemTime(startTime);

    const lookupOffsets: number[] = [];
    const delayedRun = buildAgentRunRow({ agent_job_id: "job-existing", id: "run-existing" });
    const { admin, supabase } = buildSupabaseMocks({
      activeJobRow: buildAgentJobRow({ id: "job-existing" }),
      agentConfig: [],
      insertedRunRows: [],
      jobInsertError: uniqueViolationError,
      loadRunByJobId: () => {
        const offset = Date.now() - startTime;
        lookupOffsets.push(offset);

        return offset > 200 ? delayedRun : null;
      },
    });

    const resultPromise = enqueueWallieRun({
      admin,
      sessionId: "sess-1",
      requestedByMemberId: "mem-1",
      supabase,
      triggerType: "manual_run",
      workspace: { id: "ws-1", name: "Acme", slug: "acme" },
    });

    await vi.advanceTimersByTimeAsync(40);
    await vi.advanceTimersByTimeAsync(80);
    await vi.advanceTimersByTimeAsync(160);

    const result = await resultPromise;

    expect(result.created).toBe(false);
    expect(result.jobId).toBe("job-existing");
    expect(result.run.id).toBe("run-existing");
    expect(lookupOffsets.some((offset) => offset > 200)).toBe(true);
  });

  it("throws a typed retryable error and logs when the run lookup budget is exhausted", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(baseTimestamp);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { admin, supabase } = buildSupabaseMocks({
      activeJobRow: buildAgentJobRow({ id: "job-existing" }),
      agentConfig: [],
      insertedRunRows: [],
      jobInsertError: uniqueViolationError,
      loadRunByJobId: () => null,
    });

    const resultPromise = enqueueWallieRun({
      admin,
      runLookupRetry: {
        initialDelayMs: 40,
        maxDelayMs: 80,
        maxElapsedMs: 120,
      },
      sessionId: "sess-1",
      requestedByMemberId: "mem-1",
      supabase,
      triggerType: "manual_run",
      workspace: { id: "ws-1", name: "Acme", slug: "acme" },
    });
    const rejection = expect(resultPromise).rejects.toMatchObject({
      code: "run_lookup_timeout",
      statusCode: 503,
    });

    await vi.advanceTimersByTimeAsync(40);
    await vi.advanceTimersByTimeAsync(80);

    await rejection;
    expect(consoleError).toHaveBeenCalledWith(
      "Wallie run lookup exhausted after duplicate enqueue",
      expect.objectContaining({
        jobId: "job-existing",
        maxElapsedMs: 120,
      }),
    );
  });

  it("aborts an in-flight run lookup when the deadline expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(baseTimestamp);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    let lookupCount = 0;
    const { admin, supabase } = buildSupabaseMocks({
      activeJobRow: buildAgentJobRow({ id: "job-existing" }),
      agentConfig: [],
      insertedRunRows: [],
      jobInsertError: uniqueViolationError,
      loadRunByJobId: (signal) => {
        lookupCount += 1;

        return new Promise((_, reject) => {
          signal?.addEventListener(
            "abort",
            () => {
              reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
            },
            { once: true },
          );
        });
      },
    });

    const resultPromise = enqueueWallieRun({
      admin,
      runLookupRetry: {
        initialDelayMs: 40,
        maxDelayMs: 80,
        maxElapsedMs: 120,
      },
      sessionId: "sess-1",
      requestedByMemberId: "mem-1",
      supabase,
      triggerType: "manual_run",
      workspace: { id: "ws-1", name: "Acme", slug: "acme" },
    });
    const rejection = expect(resultPromise).rejects.toMatchObject({
      code: "run_lookup_timeout",
      statusCode: 503,
    });

    await vi.advanceTimersByTimeAsync(120);

    await rejection;
    expect(lookupCount).toBe(1);
    expect(consoleError).toHaveBeenCalledWith(
      "Wallie run lookup exhausted after duplicate enqueue",
      expect.objectContaining({
        attempts: 1,
        jobId: "job-existing",
        maxElapsedMs: 120,
      }),
    );
  });
});
