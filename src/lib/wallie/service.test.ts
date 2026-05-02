import { describe, expect, it, vi } from "vitest";

import { claimQueuedJobCandidate, enqueueWallieRun } from "@/lib/wallie/service";

vi.mock("@/lib/pipeline/processor", () => ({
  processPipelineJob: vi.fn(),
}));

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

function buildSupabaseMocks(opts: {
  agentConfig: AgentConfigRow[];
  insertedRunRows: Array<Record<string, unknown>>;
}) {
  const sessionRow = {
    id: "sess-1",
    workspace_id: "ws-1",
    number: 1,
    title: "Add SSO",
    prompt_md: "Add SSO via Google Workspace",
    created_at: new Date().toISOString(),
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

  const insertedJobRow = {
    id: "job-1",
    workspace_id: "ws-1",
    session_id: "sess-1",
    requested_by_member_id: "mem-1",
    trigger_type: "manual",
    status: "queued",
    attempt_count: 0,
    last_error: null,
    dedupe_key: "session:sess-1:active",
    job_type: "session",
    scheduled_at: null,
    started_at: null,
    finished_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const admin = {
    from: (table: string) => {
      if (table === "workspace_secrets") {
        // No missing required secrets.
        return {
          select: () => ({
            eq: () => ({
              in: async () => ({
                data: [{ key: "ANTHROPIC_API_KEY" }],
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === "agent_runs") {
        return {
          select: () => ({
            eq: () => ({
              in: () => ({
                order: () => ({
                  limit: () => ({
                    maybeSingle: async () => ({ data: null, error: null }),
                  }),
                }),
              }),
            }),
          }),
          insert: (row: Record<string, unknown>) => {
            opts.insertedRunRows.push(row);
            return {
              select: () => ({
                single: async () => ({
                  data: { id: "run-1", ...row },
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
              single: async () => ({ data: insertedJobRow, error: null }),
            }),
          }),
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
});
