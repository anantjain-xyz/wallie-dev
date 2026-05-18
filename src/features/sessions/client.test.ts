import { describe, expect, it, vi } from "vitest";

import { createSessionFromClient } from "./client";

interface InsertedRow {
  current_stage_id: string;
  linear_issue_id: string | null;
  linear_issue_url: string | null;
  number: number;
  phase_status: string;
  pipeline_id: string;
  prompt_md: string;
  title: string;
  workspace_id: string;
}

interface MockOptions {
  onboardingError?: { message: string } | null;
  onboardingRow?: { status: string } | null;
  nextNumber?: number;
  nextNumberError?: { message: string } | null;
  pipelineRow?: { id: string } | null;
  pipelineError?: { message: string } | null;
  firstStageRow?: { id: string } | null;
  stageError?: { message: string } | null;
  sessionInsertError?: { message: string } | null;
}

function buildSupabaseMock(opts: MockOptions = {}) {
  const inserts: InsertedRow[] = [];
  const pipelineSelectFilters: Array<{ column: string; value: unknown }> = [];

  const supabase = {
    rpc: vi.fn(async () => {
      if (opts.nextNumberError) {
        return { data: null, error: opts.nextNumberError };
      }
      return { data: opts.nextNumber ?? 7, error: null };
    }),
    from(table: string) {
      if (table === "workspace_onboarding") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data:
                  opts.onboardingRow === undefined ? { status: "completed" } : opts.onboardingRow,
                error: opts.onboardingError ?? null,
              }),
            }),
          }),
        };
      }
      if (table === "pipelines") {
        return {
          select: () => {
            const chain = {
              eq(column: string, value: unknown) {
                pipelineSelectFilters.push({ column, value });
                return chain;
              },
              maybeSingle: async () => ({
                data: opts.pipelineRow === undefined ? { id: "pipe-1" } : opts.pipelineRow,
                error: opts.pipelineError ?? null,
              }),
            };
            return chain;
          },
        };
      }
      if (table === "pipeline_stages") {
        return {
          select: () => ({
            eq: () => ({
              order: () => ({
                limit: () => ({
                  maybeSingle: async () => ({
                    data: opts.firstStageRow === undefined ? { id: "stage-1" } : opts.firstStageRow,
                    error: opts.stageError ?? null,
                  }),
                }),
              }),
            }),
          }),
        };
      }
      if (table === "sessions") {
        return {
          insert: async (row: InsertedRow) => {
            inserts.push(row);
            return { error: opts.sessionInsertError ?? null };
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };

  return { supabase: supabase as never, inserts, pipelineSelectFilters };
}

describe("createSessionFromClient", () => {
  it("rejects an empty prompt before touching the database", async () => {
    const { supabase } = buildSupabaseMock();
    await expect(
      createSessionFromClient(supabase, { promptMd: "   ", workspaceId: "ws-1" }),
    ).rejects.toThrow("Prompt is required.");
    expect((supabase as { rpc: ReturnType<typeof vi.fn> }).rpc).not.toHaveBeenCalled();
  });

  it("returns the workspace's next session number from the RPC", async () => {
    const { supabase } = buildSupabaseMock({ nextNumber: 42 });
    const result = await createSessionFromClient(supabase, {
      promptMd: "Add SSO via Google Workspace",
      workspaceId: "ws-1",
    });
    expect(result).toEqual({ number: 42 });
    const rpc = (supabase as { rpc: ReturnType<typeof vi.fn> }).rpc;
    expect(rpc).toHaveBeenCalledWith("next_session_number", { target_workspace_id: "ws-1" });
  });

  it("propagates the RPC error when the next-number lookup fails", async () => {
    const { supabase } = buildSupabaseMock({ nextNumberError: { message: "rpc broke" } });
    await expect(
      createSessionFromClient(supabase, {
        promptMd: "Add SSO",
        workspaceId: "ws-1",
      }),
    ).rejects.toMatchObject({ message: "rpc broke" });
  });

  it("requires completed workspace setup before allocating a session number", async () => {
    const { supabase } = buildSupabaseMock({ onboardingRow: { status: "in_progress" } });
    await expect(
      createSessionFromClient(supabase, {
        promptMd: "Add SSO",
        workspaceId: "ws-1",
      }),
    ).rejects.toThrow("Complete workspace setup before starting a session.");

    expect((supabase as { rpc: ReturnType<typeof vi.fn> }).rpc).not.toHaveBeenCalled();
  });

  it("derives the title from the first non-empty prompt line when no title is supplied", async () => {
    const { supabase, inserts } = buildSupabaseMock();
    await createSessionFromClient(supabase, {
      promptMd: "\n\n# Add SSO via Google Workspace\n\nDetails follow…",
      workspaceId: "ws-1",
    });
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.title).toBe("Add SSO via Google Workspace");
  });

  it("uses the explicit title when provided and trims whitespace", async () => {
    const { supabase, inserts } = buildSupabaseMock();
    await createSessionFromClient(supabase, {
      promptMd: "Long prompt body…",
      title: "  Override Title  ",
      workspaceId: "ws-1",
    });
    expect(inserts[0]!.title).toBe("Override Title");
  });

  it("extracts the Linear issue id from the URL and stores both id and url", async () => {
    const { supabase, inserts } = buildSupabaseMock();
    await createSessionFromClient(supabase, {
      linearIssueUrl: "https://linear.app/team/issue/TEAM-42/some-slug",
      promptMd: "Add SSO",
      workspaceId: "ws-1",
    });
    expect(inserts[0]!.linear_issue_id).toBe("TEAM-42");
    expect(inserts[0]!.linear_issue_url).toBe("https://linear.app/team/issue/TEAM-42/some-slug");
  });

  it("stores a null issue id when the Linear URL doesn't match the expected shape", async () => {
    const { supabase, inserts } = buildSupabaseMock();
    await createSessionFromClient(supabase, {
      linearIssueUrl: "https://example.com/not-a-linear-url",
      promptMd: "Add SSO",
      workspaceId: "ws-1",
    });
    expect(inserts[0]!.linear_issue_id).toBeNull();
    expect(inserts[0]!.linear_issue_url).toBe("https://example.com/not-a-linear-url");
  });

  it("throws when the workspace has no default pipeline configured", async () => {
    const { supabase } = buildSupabaseMock({ pipelineRow: null });
    await expect(
      createSessionFromClient(supabase, {
        promptMd: "Add SSO",
        workspaceId: "ws-1",
      }),
    ).rejects.toThrow("Workspace has no default pipeline configured.");
  });

  it("throws when the default pipeline has no stages", async () => {
    const { supabase } = buildSupabaseMock({ firstStageRow: null });
    await expect(
      createSessionFromClient(supabase, {
        promptMd: "Add SSO",
        workspaceId: "ws-1",
      }),
    ).rejects.toThrow("Default pipeline has no stages configured.");
  });

  it("inserts the session row pinned to the default pipeline's first stage and agent_generating status", async () => {
    const { supabase, inserts, pipelineSelectFilters } = buildSupabaseMock({
      nextNumber: 9,
      pipelineRow: { id: "pipe-default" },
      firstStageRow: { id: "stage-first" },
    });
    await createSessionFromClient(supabase, {
      promptMd: "Add SSO",
      workspaceId: "ws-7",
    });
    expect(inserts).toHaveLength(1);
    const row = inserts[0]!;
    expect(row.current_stage_id).toBe("stage-first");
    expect(row.pipeline_id).toBe("pipe-default");
    expect(row.workspace_id).toBe("ws-7");
    expect(row.number).toBe(9);
    expect(row.phase_status).toBe("agent_generating");
    expect(row.prompt_md).toBe("Add SSO");

    // Sanity-check that we filter pipelines by workspace_id + is_default — without this,
    // a workspace switch could pick another tenant's pipeline.
    const filterMap = Object.fromEntries(pipelineSelectFilters.map((f) => [f.column, f.value]));
    expect(filterMap).toEqual({ workspace_id: "ws-7", is_default: true });
  });

  it("propagates the session insert error so callers can surface it", async () => {
    const { supabase } = buildSupabaseMock({
      sessionInsertError: { message: "duplicate key" },
    });
    await expect(
      createSessionFromClient(supabase, {
        promptMd: "Add SSO",
        workspaceId: "ws-1",
      }),
    ).rejects.toMatchObject({ message: "duplicate key" });
  });
});
