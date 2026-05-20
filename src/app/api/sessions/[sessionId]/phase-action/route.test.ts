import { describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  createSupabaseAdminClient: vi.fn(() => ({})),
  createSupabaseServerClient: vi.fn(),
  enforceRateLimit: vi.fn(),
  getSupabaseUserOrNull: vi.fn(),
  handleApproval: vi.fn(),
  handleRejection: vi.fn(),
  processQueuedAgentJobs: vi.fn(),
}));

vi.mock("@/lib/pipeline/processor", () => ({
  handleApproval: mocked.handleApproval,
  handleRejection: mocked.handleRejection,
}));

vi.mock("@/lib/rate-limit", () => ({
  enforceRateLimit: mocked.enforceRateLimit,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: mocked.createSupabaseAdminClient,
}));

vi.mock("@/lib/supabase/auth", () => ({
  getSupabaseUserOrNull: mocked.getSupabaseUserOrNull,
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: mocked.createSupabaseServerClient,
}));

vi.mock("@/lib/wallie/service", () => ({
  processQueuedAgentJobs: mocked.processQueuedAgentJobs,
}));

vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return {
    ...actual,
    after: () => {
      // Deferred processing is not part of these route assertions.
    },
  };
});

import { POST } from "./route";

function makeRequest(body: Record<string, unknown>) {
  return new Request("http://localhost:3000/api/sessions/sess-1/phase-action", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}

function buildSupabase() {
  return {
    from: (table: string) => {
      if (table === "sessions") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: {
                  current_stage_id: "stage-product",
                  id: "sess-1",
                  phase_status: "awaiting_review",
                  workspace_id: "ws-1",
                },
                error: null,
              }),
            }),
          }),
        };
      }

      if (table === "workspace_members") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: { id: "mem-reviewer", role: "owner" },
                  error: null,
                }),
              }),
            }),
          }),
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    },
  };
}

describe("POST /api/sessions/[sessionId]/phase-action", () => {
  it("attributes rejection reruns to the reviewer member", async () => {
    mocked.createSupabaseServerClient.mockResolvedValue(buildSupabase());
    mocked.getSupabaseUserOrNull.mockResolvedValue({ id: "user-1" });
    mocked.enforceRateLimit.mockResolvedValue({ response: null });
    mocked.handleRejection.mockResolvedValue({ jobId: "job-1", success: true });

    const response = await POST(
      makeRequest({ action: "reject", feedbackText: "Needs sharper scope.", version: 1 }),
      { params: Promise.resolve({ sessionId: "sess-1" }) },
    );

    expect(response.status).toBe(200);
    expect(mocked.handleRejection).toHaveBeenCalledWith({
      expectedWorkspaceId: "ws-1",
      feedbackText: "Needs sharper scope.",
      requestedByMemberId: "mem-reviewer",
      sessionId: "sess-1",
      version: 1,
    });
  });
});
